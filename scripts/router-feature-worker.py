"""Private fn worker for the real Claude Code direct/New API comparison."""

import http.cookiejar
import json
import os
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

credential_file = sys.argv[1]
with open(credential_file) as source:
    sites = json.load(source)
client_token = json.loads(sys.stdin.readline())["client_token"]
cases = {}
case_lock = threading.Lock()
newapi = {"base": None, "token": None, "channels": {}}


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


def clean(value):
    for site in sites.values():
        if site.get("key"):
            value = value.replace(site["key"], "[redacted]")
    for token in [client_token, newapi.get("token")]:
        if token:
            value = value.replace(token, "[redacted]")
    return value[:600]


def summary(case):
    front = case.get("front")
    wire = case.get("wire")
    result = {k: v for k, v in case.items() if k not in ["front", "wire", "cached", "gate"]}
    if front and wire:
        skip = {"authorization", "x-api-key", "cookie", "host", "content-length",
                "connection", "accept-encoding", "transfer-encoding"}
        differences = [k for k, v in front["headers"].items()
                       if k not in skip and wire["headers"].get(k) != v]
        result.update({
            "body_exact": front["body"] == wire["body"],
            "user_agent": front["headers"].get("user-agent"),
            "user_agent_retained": front["headers"].get("user-agent") == wire["headers"].get("user-agent"),
            "client_headers_retained": not differences,
            "changed_header_names": differences,
            "client_header_names": sorted(k for k in front["headers"] if k not in skip),
            "model": json.loads(front["body"]).get("model"),
            "upstream_auth": {"bearer": bool(wire["headers"].get("authorization")),
                              "api_key": bool(wire["headers"].get("x-api-key"))},
        })
    return result


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def authorized(self):
        return self.headers.get("Authorization") == "Bearer " + client_token or self.headers.get("x-api-key") == client_token

    def do_GET(self):
        if self.path != "/_audit" or not self.authorized():
            self.send_error(404)
            return
        raw = json.dumps({k: summary(v) for k, v in cases.items()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        route = self.path.split("?", 1)[0].strip("/").split("/")
        if len(route) < 3 or route[0] not in ["direct", "gateway", "upstream"] or route[1] not in sites:
            self.send_error(404)
            return
        kind, site_name = route[:2]
        site = sites[site_name]
        if not site.get("key"):
            self.send_error(400)
            return
        if kind == "upstream":
            valid = self.headers.get("x-api-key") == site["key"] or self.headers.get("Authorization") == "Bearer " + site["key"]
        else:
            valid = self.authorized()
        if not valid:
            self.send_error(401)
            return
        suffix = self.path[len("/" + kind + "/" + site_name):]
        if not suffix.split("?", 1)[0] == "/v1/messages":
            self.send_error(404)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        headers = {k.lower(): v for k, v in self.headers.items()}
        name = site_name + ("-gateway" if kind == "upstream" else "-" + kind)
        with case_lock:
            case = cases.setdefault(name, {"gate": threading.Lock(), "public_requests": 0,
                                           "incoming_attempts": 0, "created_at": datetime.now(timezone.utc).isoformat()})
            if kind != "upstream":
                case["incoming_attempts"] += 1
                case.setdefault("front", {"body": body, "headers": headers})
        outbound = {k: v for k, v in headers.items() if k not in ["host", "content-length", "connection", "accept-encoding"]}
        if kind == "gateway":
            url = newapi["base"] + suffix
            token = newapi["token"] + "-" + str(newapi["channels"][site_name])
            outbound["authorization"] = "Bearer " + token
            if "x-api-key" in outbound:
                outbound["x-api-key"] = token
            self.forward(url, body, outbound, case, public=False)
            return
        if kind == "direct":
            outbound.pop("x-api-key", None)
            outbound["authorization"] = "Bearer " + site["key"]
        with case["gate"]:
            if "cached" in case:
                code, response_headers, data = case["cached"]
                case["cached_retries"] = case.get("cached_retries", 0) + 1
                self.respond(code, response_headers, data)
                return
            case["wire"] = {"body": body, "headers": outbound}
            case["public_requests"] += 1
            case["upstream_path"] = suffix
            self.forward(site["root"] + suffix, body, outbound, case, public=True)

    def respond(self, status, headers, body):
        self.send_response(status)
        for k, v in headers.items():
            if k.lower() in ["content-type", "retry-after", "request-id", "x-request-id"]:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def forward(self, url, body, headers, case, public):
        started = time.monotonic()
        try:
            req = urllib.request.Request(url, body, headers=headers)
            try:
                response = urllib.request.urlopen(req, timeout=45)
            except urllib.error.HTTPError as error:
                response = error
            status = response.code
            response_headers = dict(response.headers)
            self.send_response(status)
            for k, v in response_headers.items():
                if k.lower() in ["content-type", "retry-after", "request-id", "x-request-id"]:
                    self.send_header(k, v)
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            chunks = []
            while True:
                chunk = response.read1(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                try:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
            data = b"".join(chunks)
            response.close()
            if public:
                case["upstream_status"] = status
                case["elapsed_ms"] = round((time.monotonic() - started) * 1000)
                case["cached"] = status, response_headers, data
                if status != 200:
                    try:
                        error = json.loads(data).get("error", {})
                        message = error.get("message", error) if isinstance(error, dict) else error
                    except (ValueError, AttributeError):
                        message = data.decode(errors="replace")
                    case["error_summary"] = clean(str(message))
            else:
                case["gateway_status"] = status
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            field = "upstream_error" if public else "gateway_error"
            case[field] = clean(str(error))
            case["elapsed_ms"] = round((time.monotonic() - started) * 1000)
            data = json.dumps({"error": {"message": "test transport: " + case[field]}}).encode()
            if public:
                case["cached"] = 502, {"Content-Type": "application/json"}, data
            self.respond(502, {"Content-Type": "application/json"}, data)


image = docker("inspect", "new-api", "--format", "{{.Image}}")
bridge = docker("network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}")
server = ThreadingHTTPServer(("0.0.0.0", 0), Proxy)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    api_port = listener.getsockname()[1]
name = "arc-router-live-" + secrets.token_hex(4)
volume = name + "-data"
newapi["base"] = f"http://127.0.0.1:{api_port}"
admin = {}
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def api(path, data=None, method=None):
    raw = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(newapi["base"] + path, raw, method=method,
                                 headers={"Content-Type": "application/json", **admin})
    result = json.loads(opener.open(req, timeout=20).read())
    if result.get("success") is False:
        raise RuntimeError(clean(path + ": " + result.get("message", "API failed")))
    return result.get("data", result)


def rows(value):
    return value if isinstance(value, list) else value["items"]


created = False
try:
    docker("volume", "create", volume)
    docker("create", "--name", name, "-p", f"127.0.0.1:{api_port}:3000",
           "-v", volume + ":/data", "-e", "TZ=Asia/Shanghai", image)
    created = True
    docker("start", name)
    for attempt in range(45):
        try:
            api("/api/setup")
            break
        except (urllib.error.URLError, ConnectionError):
            time.sleep(1)
    else:
        raise RuntimeError("isolated gateway did not start")
    password = secrets.token_urlsafe(24) + "Aa1!"
    api("/api/setup", {"username": "arcaudit", "password": password,
                       "confirmPassword": password, "SelfUseModeEnabled": True, "DemoSiteEnabled": False})
    login = api("/api/user/login", {"username": "arcaudit", "password": password})
    admin = {"Authorization": "Bearer " + login["access_token"], "New-Api-User": str(login["user"]["id"])}
    ratios = {site["model"]: 1 for site in sites.values() if site.get("key")}
    api("/api/option/", {"key": "ModelRatio", "value": json.dumps(ratios)}, "PUT")
    for site_name, site in sites.items():
        if not site.get("key"):
            continue
        api("/api/channel/", {"mode": "single", "channel": {
            "type": 14, "name": site_name, "key": site["key"], "models": site["model"],
            "base_url": f"http://{bridge}:{server.server_port}/upstream/{site_name}",
            "group": "default", "status": 1, "auto_ban": 0, "priority": 0, "weight": 100,
            "setting": json.dumps({"pass_through_body_enabled": True}),
            "header_override": json.dumps({"*": True, "Authorization": "Bearer {api_key}"}),
        }})
    newapi["channels"] = {c["name"]: c["id"] for c in rows(api("/api/channel/"))}
    api("/api/token/", {"name": "fixture", "expired_time": -1, "remain_quota": 0,
                       "unlimited_quota": True, "group": "default", "cross_group_retry": False})
    token_id = rows(api("/api/token/search?keyword=fixture"))[0]["id"]
    newapi["token"] = api(f"/api/token/{token_id}/key", {}, "POST")["key"]
    print(json.dumps({"port": server.server_port, "sites": {
        k: {"has_key": bool(v.get("key")), "model": v["model"], "cli_model": v.get("cli_model", v["model"]), "headers": v["headers"],
            "source": v["source"], "credential_error": v.get("credential_error")}
        for k, v in sites.items()}}), flush=True)
    sys.stdin.readline()
finally:
    server.shutdown()
    server.server_close()
    if created:
        docker("rm", "-f", name)
    docker("volume", "rm", volume)
    os.unlink(credential_file)
    print(json.dumps({"cleaned": True, "cases": {k: summary(v) for k, v in cases.items()}}), flush=True)
