import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { callRuntime } from '../src/runtime-client.js';

const root = resolve(import.meta.dirname, '..');
const prompt = '建立台灣半導體供應鏈入門頁，清楚說明五家公司角色、股票代號與資料來源。';
function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'tsmc-python-test-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  return (command, payload = {}) => callRuntime(command, payload, { stateDir });
}

test('Slice A stops at hard gate with no Slice B task', async t => {
  const call = fixture(t);
  const run = await call('start', { prompt, provider: 'mock' });
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.checks.deterministic.pass, true);
  assert.equal((await call('list')).length, 1);
  assert.deepEqual((await call('status', { runId: run.id })).artifacts.map(x => x.name), ['app.js', 'index.html', 'styles.css']);
});

test('approval creates a new task and replay is idempotent', async t => {
  const call = fixture(t);
  const parent = await call('start', { prompt, provider: 'mock' });
  const child = await call('approve', { runId: parent.id });
  assert.equal(child.parent_id, parent.id);
  assert.equal(child.stage, 'slice_b_verify');
  assert.equal(child.status, 'complete');
  assert.equal((await call('approve', { runId: parent.id })).id, child.id);
  assert.equal((await call('list')).length, 2);
});

test('bad content and out-of-write-set tool call are held', async t => {
  const call = fixture(t);
  for (const variant of ['missing-source', 'escape']) {
    const run = await call('start', { prompt, provider: 'mock', variant });
    assert.equal(run.status, 'held');
    await assert.rejects(call('approve', { runId: run.id }), /not awaiting approval/);
  }
});

test('semantic uncertainty remains at owner gate', async t => {
  const call = fixture(t);
  const run = await call('start', { prompt, provider: 'mock', variant: 'uncertain' });
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.checks.semantic.verdict, 'uncertain');
});

test('merged PR starts distinct task after approval, with deduplication', async t => {
  const call = fixture(t);
  const parent = await call('start', { prompt, provider: 'mock' });
  const event = { deliveryId: 'delivery-12345678', runId: parent.id, commitSha: 'a'.repeat(40) };
  await assert.rejects(call('merge', event), /gate is still open/);
  await call('approve', { runId: parent.id });
  const continuation = await call('merge', event);
  assert.equal(continuation.stage, 'post_merge_check');
  assert.equal(continuation.status, 'complete');
  assert.equal((await call('merge', event)).id, continuation.id);
  assert.equal((await call('list')).length, 3);
});

test('web assets and stage manifest keep source and scope requirements', () => {
  const html = readFileSync(join(root, 'public/index.html'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(root, 'harness.json')));
  for (const item of manifest.checks.required_text) assert.ok(html.includes(item));
  for (const item of manifest.checks.required_links) assert.ok(html.includes(item));
});
