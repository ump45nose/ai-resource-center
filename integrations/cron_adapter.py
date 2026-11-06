"""Use from an existing cron entrypoint; never starts or resumes a scheduled job."""
import argparse
from http.client import HTTPException
import json
import os
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen


class ResourceCenter:
    def __init__(self, config_file):
        self.config_path = Path(config_file)
        self.config = json.loads(self.config_path.read_text())
        self.outbox = Path(self.config.get("outbox", str(self.config_path.parent / "resource-center-outbox")))

    def request(self, path, payload, method="POST"):
        request = Request(self.config["url"].rstrip("/") + "/api/v2" + path,
                          data=json.dumps(payload).encode() if payload is not None else None, method=method,
                          headers={"Authorization": "Bearer " + self.config["token"],
                                   "Content-Type": "application/json"})
        with urlopen(request, timeout=90) as response:
            return json.load(response)

    def publish(self, tasks):
        return self.request("/cron/tasks", {"tasks": tasks})

    def prepare(self, task_id, run_id, binding_id=None, execution_mode="scheduled"):
        """Returns one-run inference config to the caller; do not log its credentials."""
        return self.request("/cron/runs/prepare", {"taskId": task_id, "runId": run_id, "executionMode": execution_mode, **({"bindingId": binding_id} if binding_id else {})})

    def result(self, result):
        """Persist receipt before upload. A failed upload never reruns business work."""
        self.outbox.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = self.outbox / (quote(str(result["runId"]), safe="") + ".json")
        temp = path.with_suffix(".tmp")
        with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as stream:
            json.dump(result, stream)
        temp.replace(path)
        response = self.request("/ingest/task-results", result)
        if response.get("acknowledged"):
            path.unlink()
        return response

    def flush(self):
        saved, pending = 0, 0
        for path in sorted(self.outbox.glob("*.json")):
            try:
                response = self.request("/ingest/task-results", json.loads(path.read_text()))
                if response.get("acknowledged"):
                    path.unlink()
                    saved += 1
                else:
                    pending += 1
            except (OSError, HTTPException, ValueError):
                # Unreadable or unsent receipts stay for the next round; keep flushing the rest.
                pending += 1
        return {"acknowledged": saved, "pending": pending}


def publish_profile(client, profile):
    # Read only the existing scheduler file. No Hermes trigger/update API is used.
    value = json.loads((Path(profile) / "cron" / "jobs.json").read_text())
    jobs = value["jobs"] if isinstance(value, dict) else value
    configured = set(client.config.get("adaptedTaskIds", []))
    previews = set(client.config.get("previewTaskIds", []))
    tasks = [{"id": str(job["id"]), "name": job.get("name") or str(job["id"]),
              "enabled": job.get("enabled", True), "schedule": job.get("schedule"),
              "timezone": job.get("timezone") or "Asia/Shanghai",
              "supportsRunConfig": str(job["id"]) in configured | previews,
              "supportsResult": str(job["id"]) in configured | previews,
              "supportsPreview": str(job["id"]) in previews,
              "supportsScheduledRunConfig": str(job["id"]) in configured}
             for job in jobs]
    return client.publish(tasks)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--publish-profile")
    parser.add_argument("--flush", action="store_true")
    args = parser.parse_args()
    client = ResourceCenter(args.config)
    result = publish_profile(client, args.publish_profile) if args.publish_profile else client.flush() if args.flush else {"message": "choose --publish-profile or --flush"}
    print(json.dumps(result, ensure_ascii=False))
