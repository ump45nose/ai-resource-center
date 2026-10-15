import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test("native historical metadata deduplicates swipes and copied chats without exporting text or guessing sites", () => {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import importlib.util,json,tempfile
from pathlib import Path
spec=importlib.util.spec_from_file_location('history','scripts/import-sillytavern-history.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 root=Path(d);user=root/'user';chats=user/'chats'/'PRIVATE CHARACTER';chats.mkdir(parents=True);(user/'settings.json').write_text('{}')
 one={'is_user':False,'mes':'PRIVATE PROMPT AND RESPONSE','gen_started':'2026-10-15T00:00:00.000Z','gen_finished':'2026-10-15T00:00:02.000Z','extra':{'api':'custom','model':'model','token_count':23,'time_to_first_token':200}}
 one['swipe_info']=[{k:v for k,v in one.items() if k in ['gen_started','gen_finished','extra']}]
 for name in ['PRIVATE CHAT.jsonl','renamed.jsonl']:(chats/name).write_text(json.dumps(one)+'\\n'+json.dumps({'is_user':False,'mes':'greeting'})+'\\n')
 counts=dict(files=0,invalidLines=0,missingMetadata=0,duplicates=0,records=0)
 events=list(m.extract(root,m.timestamp('2026-10-14T00:00:00Z'),m.timestamp('2026-10-16T00:00:00Z'),counts))
 print(json.dumps({'events':events,'counts':counts}))
`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const r = JSON.parse(result.stdout);
  assert.equal(r.events.length, 1);
  const [device, event] = r.events[0];
  assert.equal(device, "fn:user");
  assert.equal(event.result, "unknown");
  assert.equal(event.outputTokens, 23);
  assert.equal(event.tokenBasis, "local_estimate");
  assert.equal(event.latency, 2000);
  assert.equal(event.channelId, undefined);
  assert.equal(event.baseUrl, undefined);
  assert.ok(!result.stdout.includes("PRIVATE"));
  assert.equal(r.counts.duplicates, 3);
});
