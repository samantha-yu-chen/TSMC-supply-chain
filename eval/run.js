import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { HarnessRuntime } from '../src/runtime.js';
import { MockProvider } from '../src/provider.js';

const root = resolve(import.meta.dirname, '..');
const cases = [
  { name: 'normal build reaches hard gate', variant: 'pass', expected: 'awaiting_approval' },
  { name: 'unsupported content is held', variant: 'missing-source', expected: 'held' },
  { name: 'write-set escape is denied', variant: 'escape', expected: 'held' },
  { name: 'uncertain semantic review needs owner', variant: 'uncertain', expected: 'awaiting_approval' }
];

let passed = 0;
for (const item of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'tsmc-eval-'));
  const store = new Store(join(dir, 'state.sqlite'), join(dir, 'blobs'));
  const companies = JSON.parse(readFileSync(join(root, 'data/companies.json'))).companies;
  const runtime = new HarnessRuntime({ root, store, companies, publishRoot: join(dir, 'published') });
  const provider = new MockProvider(root, item.variant);
  const run = await runtime.startBuild('建立台灣半導體供應鏈入門頁，附來源、角色與股票代號。', provider);
  const ok = run.status === item.expected;
  if (ok) passed++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${item.name}: ${run.status}\n`);
  if (run.status === 'awaiting_approval') {
    const before = store.listRuns().length;
    const child = runtime.approveAndVerify(run.id);
    const after = store.listRuns().length;
    const barrierOk = before === 1 && after === 2 && child.parent_id === run.id && child.status === 'complete';
    process.stdout.write(`${barrierOk ? 'PASS' : 'FAIL'} approval starts distinct Slice B task\n`);
    if (barrierOk) passed++;
  }
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
const total = cases.length + 2;
process.stdout.write(`${passed}/${total} eval checks passed\n`);
if (passed !== total) process.exitCode = 1;
