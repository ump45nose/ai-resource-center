"""Run on fn: use the deployed image in an isolated container and a local stub."""

import http.cookiejar
import json
import secrets
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()


observed = []


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("content-length", 0)))
        body = json.loads(raw)
        observed.append({"path": self.path, "body": raw, "headers": self.headers})
        if self.path.startswith("/v1/responses"):
            result = {
                "id": "resp_fixture", "object": "response", "status": "completed",
                "model": body["model"], "output": [],
                "usage": {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3},
            }
        else:
            result = {
                "id": "msg_fixture", "type": "message", "role": "assistant",
                "model": body["model"],
                "content": [{"type": "text", "text": "ok"}],
                "stop_reason": "end_turn", "stop_sequence": None,
                "usage": {"input_tokens": 2, "output_tokens": 1},
            }
        if body.get("stream"):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            message = {**result, "content": [], "stop_reason": None}
            events = [
                ("message_start", {"type": "message_start", "message": message}),
                ("content_block_start", {"type": "content_block_start", "index": 0,
                                         "content_block": {"type": "text", "text": ""}}),
                ("content_block_delta", {"type": "content_block_delta", "index": 0,
                                         "delta": {"type": "text_delta", "text": "ok"}}),
                ("content_block_stop", {"type": "content_block_stop", "index": 0}),
                ("message_delta", {"type": "message_delta",
                                   "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                                   "usage": {"output_tokens": 1}}),
                ("message_stop", {"type": "message_stop"}),
            ]
            for name, event in events:
                self.wfile.write((f"event: {name}\ndata: {json.dumps(event)}\n\n").encode())
                self.wfile.flush()
        else:
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())


image = docker("inspect", "new-api", "--format", "{{.Image}}")
bridge = docker("network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}")
stub = ThreadingHTTPServer((bridge, 0), Upstream)
threading.Thread(target=stub.serve_forever, daemon=True).start()
with socket.socket() as listener:
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
name = "arc-passthrough-" + secrets.token_hex(4)
volume = name + "-data"
base = f"http://127.0.0.1:{port}"
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
admin_headers = {}


def api(path, data=None, method=None):
    payload = None if data is None else json.dumps(data).encode()
    req = urllib.request.Request(base + path, payload, method=method,
                                 headers={"Content-Type": "application/json", **admin_headers})
    result = json.loads(opener.open(req, timeout=20).read())
    if result.get("success") is False:
        raise RuntimeError(f"{path}: {result.get('message')}")
    return result.get("data", result)


def rows(value):
    return value if isinstance(value, list) else value["items"]


def request(path, body, token, headers):
    raw = (json.dumps(body, indent=2) + "\n").encode()
    req = urllib.request.Request(base + path, raw, headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token, **headers,
    })
    try:
        response = urllib.request.urlopen(req, timeout=20)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{path}: HTTP {error.code}: {error.read().decode()}") from error
    result = response.read()
    assert response.status == 200
    seen = observed[-1]
    return {
        "status": response.status,
        "body_exact": seen["body"] == raw,
        "unknown_field_retained": json.loads(seen["body"]).get("client_only_marker") == body["client_only_marker"],
        "user_agent_retained": seen["headers"].get("User-Agent") == headers["User-Agent"],
        "client_headers_retained": all(seen["headers"].get(k) == v for k, v in headers.items()),
        "upstream_auth_replaced": seen["headers"].get("x-api-key") == "sk-arc-local-stub" if path.startswith("/v1/messages") else seen["headers"].get("Authorization") == "Bearer sk-arc-local-stub",
        "path": seen["path"],
        "stream_returned": b"event: message_stop" in result if body.get("stream") else None,
    }


report = {"checked_at": datetime.now(timezone.utc).isoformat(),
          "scope": "deployed New API image in an isolated container; local stub only"}
created = False
try:
    docker("volume", "create", volume)
    docker("run", "-d", "--name", name, "-p", f"127.0.0.1:{port}:3000",
           "-v", volume + ":/data", "-e", "TZ=Asia/Shanghai", image)
    created = True
    for attempt in range(45):
        try:
            api("/api/setup")
            break
        except (urllib.error.URLError, ConnectionError):
            time.sleep(1)
    else:
        raise RuntimeError("isolated New API did not start")
    password = secrets.token_urlsafe(24) + "Aa1!"
    api("/api/setup", {"username": "arcaudit", "password": password,
                       "confirmPassword": password, "SelfUseModeEnabled": True, "DemoSiteEnabled": False})
    login = api("/api/user/login", {"username": "arcaudit", "password": password})
    admin_headers["Authorization"] = "Bearer " + login["access_token"]
    admin_headers["New-Api-User"] = str(login["user"]["id"])
    assert api("/api/user/self")["username"] == "arcaudit"
    api("/api/token/", {"name": "fixture", "remain_quota": 0, "unlimited_quota": True,
                       "expired_time": -1, "group": "default"})
    token_id = rows(api("/api/token/search?keyword=fixture"))[0]["id"]
    token = api(f"/api/token/{token_id}/key", {}, "POST")["key"]
    channels = {}
    for protocol, kind, model in [("anthropic", 14, "claude-sonnet-4-6"), ("responses", 1, "gpt-4o-mini")]:
        api("/api/channel/", {"mode": "single", "channel": {
            "type": kind, "name": protocol, "key": "sk-arc-local-stub",
            "base_url": f"http://{bridge}:{stub.server_port}", "models": model,
            "group": "default", "status": 1, "priority": 0, "weight": 100, "auto_ban": 0,
        }})
        channels[protocol] = next(c for c in rows(api("/api/channel/")) if c["name"] == protocol)
    cc_headers = {"User-Agent": "claude-cli/2.1.0 (external, cli)", "x-app": "cli",
                  "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219",
                  "x-stainless-lang": "js", "x-claude-code-session-id": "fixture-session"}
    cc_body = {"model": "claude-sonnet-4-6", "max_tokens": 16,
               "messages": [{"role": "user", "content": "ok"}],
               "metadata": {"user_id": "fixture"}, "client_only_marker": {"fixture": True}}
    report["default_anthropic"] = request("/v1/messages?beta=true", cc_body, token, cc_headers)
    for channel in channels.values():
        channel["setting"] = json.dumps({"pass_through_body_enabled": True})
        channel["header_override"] = json.dumps({"*": True})
        update = {k: v for k, v in channel.items() if k not in [
            "key", "status", "created_time", "test_time", "response_time", "balance",
            "balance_updated_time", "used_quota", "channel_info",
        ]}
        api("/api/channel/", update, "PUT")
    report["passthrough_anthropic"] = request("/v1/messages?beta=true", cc_body, token, cc_headers)
    report["passthrough_anthropic_stream"] = request("/v1/messages?beta=true", {**cc_body, "stream": True}, token, cc_headers)
    report["passthrough_responses"] = request("/v1/responses", {
        "model": "gpt-4o-mini", "input": "ok", "client_only_marker": {"fixture": True},
    }, token, {"User-Agent": "codex_cli_rs/0.162.1", "originator": "codex_cli_rs", "session_id": "fixture-session"})
    for case in ["passthrough_anthropic", "passthrough_anthropic_stream", "passthrough_responses"]:
        assert all(report[case][k] for k in ["body_exact", "unknown_field_retained", "user_agent_retained", "client_headers_retained", "upstream_auth_replaced"]), report[case]
    assert report["passthrough_anthropic_stream"]["stream_returned"]
    report["upstream_request_count"] = len(observed)
    report["passed"] = True
finally:
    stub.shutdown()
    stub.server_close()
    if created:
        docker("rm", "-f", name)
    docker("volume", "rm", volume)
    report["isolated_resources_removed"] = True
print(json.dumps(report, ensure_ascii=False, indent=2))
