import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callRuntime } from '../src/runtime-client.js';

const cases = [
  { name: 'normal build reaches hard gate', variant: 'pass', expected: 'awaiting_approval' },
  { name: 'unsupported content is held', variant: 'missing-source', expected: 'held' },
  { name: 'write-set escape is denied', variant: 'escape', expected: 'held' },
  { name: 'uncertain semantic review needs owner', variant: 'uncertain', expected: 'awaiting_approval' }
];
let passed = 0;
for (const item of cases) {
  const stateDir = mkdtempSync(join(tmpdir(), 'tsmc-python-eval-'));
  try {
    const options = { stateDir };
    const run = await callRuntime('start', { prompt: '建立台灣半導體供應鏈入門頁，附來源、角色與股票代號。', provider: 'mock', variant: item.variant }, options);
    const ok = run.status === item.expected;
    if (ok) passed++;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${item.name}: ${run.status}\n`);
    if (run.status === 'awaiting_approval') {
      const before = (await callRuntime('list', {}, options)).length;
      const child = await callRuntime('approve', { runId: run.id }, options);
      const after = (await callRuntime('list', {}, options)).length;
      const barrierOk = before === 1 && after === 2 && child.parent_id === run.id && child.status === 'complete';
      process.stdout.write(`${barrierOk ? 'PASS' : 'FAIL'} approval starts distinct Slice B task\n`);
      if (barrierOk) passed++;
    }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
}
process.stdout.write(`${passed}/6 eval checks passed\n`);
if (passed !== 6) process.exitCode = 1;
