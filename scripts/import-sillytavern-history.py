"""Extract saved generation metadata on fn; chat text and filenames never leave the host."""
import argparse
import hashlib
import json
import math
import sys
import urllib.request
from datetime import datetime, timezone, timedelta
from pathlib import Path


def timestamp(value):
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
        except ValueError:
            return None
    return None


def extract(root, since, before, counts):
    seen = set()
    for user in sorted(root.iterdir()):
        if not user.is_dir() or not (user / 'settings.json').exists():
            continue
        paths = list((user / 'chats').glob('*/*.jsonl')) + list((user / 'group chats').glob('*.jsonl'))
        for path in paths:
            counts['files'] += 1
            with path.open(encoding='utf-8') as source:
                for line in source:
                    try:
                        msg = json.loads(line)
                    except (ValueError, UnicodeError):
                        counts['invalidLines'] += 1
                        continue
                    if msg.get('is_user', True) or msg.get('is_system'):
                        continue
                    saved = [msg] + [s for s in msg.get('swipe_info', []) if isinstance(s, dict)]
                    for item in saved:
                        start, end = timestamp(item.get('gen_started')), timestamp(item.get('gen_finished'))
                        extra = item.get('extra') or {}
                        model = extra.get('model')
                        if start is None or end is None or not isinstance(model, str) or not model or end < start:
                            counts['missingMetadata'] += 1
                            continue
                        if not since <= start < before:
                            continue
                        identity = json.dumps([user.name, start, end, extra.get('api'), model], ensure_ascii=False, separators=(',', ':'))
                        event_id = 'history:' + hashlib.sha256(identity.encode()).hexdigest()
                        if event_id in seen:
                            counts['duplicates'] += 1
                            continue
                        seen.add(event_id)
                        event = {'eventId': event_id, 'model': model, 'occurredAt': datetime.fromtimestamp(start / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'origin': 'history', 'result': 'unknown', 'latency': end - start}
                        ttft = extra.get('time_to_first_token')
                        if isinstance(ttft, (int, float)) and math.isfinite(ttft) and ttft >= 0:
                            event['ttft'] = ttft
                        tokens = extra.get('token_count')
                        if isinstance(tokens, int) and tokens >= 0:
                            event['outputTokens'] = tokens
                            event['tokenBasis'] = 'local_estimate'
                        counts['records'] += 1
                        yield 'fn:' + user.name, event


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data-root', type=Path, required=True)
    p.add_argument('--access-file', type=Path, required=True)
    p.add_argument('--days', type=int, default=90)
    p.add_argument('--before', default=datetime.now(timezone.utc).isoformat())
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args()
    before = timestamp(args.before)
    if before is None or not 1 <= args.days <= 90:
        p.error('before must be ISO date; days must be 1–90')
    access = json.loads(args.access_file.read_text())
    counts = dict(files=0, invalidLines=0, missingMetadata=0, duplicates=0, records=0, acknowledged=0)
    batch, device = [], None

    def deliver():
        if not batch or args.dry_run:
            return
        req = urllib.request.Request(access['url'].rstrip('/') + '/api/v1/rp/calls', data=json.dumps({'device': device, 'events': batch}).encode(), headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + access['sillyTavernRp']})
        result = json.loads(urllib.request.urlopen(req, timeout=30).read())
        if set(result['acknowledgedIds']) != {e['eventId'] for e in batch}:
            raise RuntimeError('Historical metadata batch not fully acknowledged')
        counts['acknowledged'] += len(batch)

    for sender, event in extract(args.data_root, before - args.days * 86400000, before, counts):
        if device != sender or len(batch) == 100:
            deliver()
            batch = []
            device = sender
        batch.append(event)
    deliver()
    print(json.dumps({'before': args.before, 'days': args.days, 'dryRun': args.dry_run, **counts}, ensure_ascii=False))


if __name__ == '__main__':
    main()
