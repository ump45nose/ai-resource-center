"""Use real Claude Code with a private fn fixture; reports never contain keys."""

import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timezone

root = Path(__file__).resolve().parents[1]
private = root / ".integration/router-live-private.json"
credential_file = json.loads(private.read_text())["credential_file"]
client_token = __import__("secrets").token_urlsafe(32)
worker_code = (root / "scripts/router-feature-worker.py").read_text()
worker = subprocess.Popen(["ssh", "201", "python3", "-u", "-c", shlex.quote(worker_code), credential_file],
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          text=True, bufsize=1)
worker.stdin.write(json.dumps({"client_token": client_token}) + "\n")
worker.stdin.flush()
forward = None
report = {"checked_at": datetime.now(timezone.utc).isoformat(),
          "client": subprocess.check_output(["claude", "--version"], text=True).strip(),
          "scope": "real Claude Code; direct and isolated fn New API share fn egress",
          "cases": {}, "credential_sources": {}}


def audit():
    req = urllib.request.Request(base + "/_audit", headers={"Authorization": "Bearer " + client_token})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())


try:
    line = worker.stdout.readline()
    if not line:
        raise RuntimeError("fixture worker did not start: " + worker.stderr.read()[-1000:])
    ready = json.loads(line)
    if "port" not in ready:
        raise RuntimeError("fixture startup failed: " + worker.stderr.read()[-1000:])
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    forward = subprocess.Popen(["ssh", "-N", "-L", f"127.0.0.1:{port}:127.0.0.1:{ready['port']}",
                                "-o", "ExitOnForwardFailure=yes", "201"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    base = f"http://127.0.0.1:{port}"
    for attempt in range(20):
        try:
            audit()
            break
        except (urllib.error.URLError, ConnectionError):
            time.sleep(0.25)
    else:
        raise RuntimeError("SSH fixture forwarding did not start")
    for site_name, site in ready["sites"].items():
        report["credential_sources"][site_name] = site["source"]
        if not site["has_key"]:
            report["cases"][site_name] = {"credential_error": site["credential_error"]}
            continue
        for mode in ["direct", "gateway"]:
            name = site_name + "-" + mode
            directory = Path(tempfile.mkdtemp(prefix="arc-cc-router-"))
            env = {k: v for k, v in os.environ.items() if not k.startswith("ANTHROPIC_")}
            env.update({
                "ANTHROPIC_BASE_URL": base + "/" + mode + "/" + site_name,
                "ANTHROPIC_AUTH_TOKEN": client_token,
                "ANTHROPIC_MODEL": site["cli_model"],
                "ANTHROPIC_CUSTOM_HEADERS": "\n".join(k + ": " + v for k, v in site["headers"].items()),
                "CLAUDE_CONFIG_DIR": str(directory / "claude"),
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
                "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "128",
                "MAX_THINKING_TOKENS": "0",
                "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
            })
            settings = directory / "settings.json"
            settings.write_text(json.dumps({"env": {k: v for k, v in env.items() if k.startswith("ANTHROPIC_")}}))
            settings.chmod(0o600)
            command = ["claude", "-p", "Reply exactly OK.", "--settings", str(settings),
                       "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                       "--disable-slash-commands", "--no-session-persistence", "--tools", "",
                       "--system-prompt", "Reply exactly OK.", "--model", site["cli_model"],
                       "--max-turns", "1", "--output-format", "json"]
            print(json.dumps({"starting": name, "model": site["cli_model"]}), flush=True)
            process = subprocess.Popen(command, cwd=directory, env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            started = time.monotonic()
            error_seen = None
            stopped = None
            try:
                while process.poll() is None:
                    observation = audit().get(name, {})
                    if observation.get("upstream_status", 200) != 200 or observation.get("upstream_error") or observation.get("gateway_error"):
                        error_seen = error_seen or time.monotonic()
                    if error_seen and time.monotonic() - error_seen > 3:
                        stopped = "upstream failure observed; stopped client retries"
                        process.terminate()
                        break
                    if time.monotonic() - started > 75:
                        stopped = "client timeout"
                        process.terminate()
                        break
                    time.sleep(1)
                output, stderr = process.communicate(timeout=10)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
                shutil.rmtree(directory)
            observation = audit().get(name, {})
            try:
                result = json.loads(output)
                client_success = process.returncode == 0 and not result.get("is_error", True)
                output_text = str(result.get("result", ""))[:60] if client_success else None
            except ValueError:
                client_success = False
                output_text = None
            observation.update({"client_exit_code": process.returncode, "client_success": client_success,
                                "client_output": output_text, "stop_reason": stopped,
                                "client_elapsed_ms": round((time.monotonic() - started) * 1000)})
            report["cases"][name] = observation
            print(json.dumps({"completed": name, **observation}, ensure_ascii=False), flush=True)
finally:
    if forward:
        forward.terminate()
        forward.communicate(timeout=10)
    if worker.poll() is None:
        worker.stdin.write("stop\n")
        worker.stdin.flush()
    final_output, worker_error = worker.communicate(timeout=30)
    for line in final_output.splitlines():
        ending = json.loads(line)
        if ending.get("cleaned"):
            report["isolated_resources_removed"] = True
            for name, case in ending.get("cases", {}).items():
                report["cases"].setdefault(name, {}).update(case)
    if worker.returncode:
        report["fixture_error"] = worker_error[-1000:]
    if report.get("isolated_resources_removed"):
        private.unlink()
    target = root / "docs/verification/router-client-features.json"
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"report": str(target), "isolated_resources_removed": report.get("isolated_resources_removed")}), flush=True)
