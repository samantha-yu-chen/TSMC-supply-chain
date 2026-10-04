import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { HarnessRuntime } from '../src/runtime.js';
import { MockProvider, ChatCompletionsProvider } from '../src/provider.js';
import { validateToolCall, checkCandidate } from '../src/policy.js';

const root = resolve(import.meta.dirname, '..');
const companies = JSON.parse(readFileSync(join(root, 'data/companies.json'))).companies;
const prompt = '建立台灣半導體供應鏈入門頁，清楚說明五家公司角色、股票代號與資料來源。';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tsmc-harness-test-'));
  const store = new Store(join(dir, 'state.sqlite'), join(dir, 'blobs'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, runtime: new HarnessRuntime({ root, store, companies, publishRoot: join(dir, 'published') }) };
}

test('Slice A seals evidence and stops before any Slice B task', async t => {
  const { store, runtime } = fixture(t);
  const run = await runtime.startBuild(prompt, new MockProvider(root));
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.checks.deterministic.pass, true);
  assert.equal(run.checks.semantic.verdict, 'pass');
  assert.equal(store.listRuns().length, 1);
  assert.deepEqual(store.artifacts(run.id).map(x => x.name), ['app.js', 'index.html', 'styles.css']);
  assert.ok(store.events(run.id).some(x => x.kind === 'run.awaiting_approval'));
});

test('approval creates a new task; replaying approval does not create a duplicate', async t => {
  const { store, runtime } = fixture(t);
  const parent = await runtime.startBuild(prompt, new MockProvider(root));
  const child = runtime.approveAndVerify(parent.id);
  assert.equal(child.parent_id, parent.id);
  assert.equal(child.stage, 'slice_b_verify');
  assert.equal(child.status, 'complete');
  assert.equal(store.getRun(parent.id).status, 'approved');
  assert.equal(runtime.approveAndVerify(parent.id).id, child.id);
  assert.equal(store.listRuns().length, 2);
});

test('missing source holds the run and cannot be approved', async t => {
  const { runtime } = fixture(t);
  const run = await runtime.startBuild(prompt, new MockProvider(root, 'missing-source'));
  assert.equal(run.status, 'held');
  assert.equal(run.checks.deterministic.pass, false);
  assert.throws(() => runtime.approveAndVerify(run.id), /not awaiting approval/);
});

test('broker rejects traversal, unknown tools and remote executable assets', () => {
  assert.throws(() => validateToolCall({ name: 'write_asset', args: { path: '../secret', content: 'x' } }), /outside/);
  assert.throws(() => validateToolCall({ name: 'approve', args: {} }), /denied/);
  assert.throws(() => validateToolCall({ name: 'write_asset', args: { path: 'index.html', content: '<script src="https://host/x.js"></script>' } }), /Remote/);
});

test('semantic uncertainty cannot clear the owner gate', async t => {
  const { store, runtime } = fixture(t);
  const run = await runtime.startBuild(prompt, new MockProvider(root, 'uncertain'));
  assert.equal(run.status, 'awaiting_approval');
  assert.equal(run.checks.semantic.verdict, 'uncertain');
  assert.equal(store.listRuns().length, 1);
});

test('merged PR starts a distinct job only after the gate and deduplicates delivery', async t => {
  const { store, runtime } = fixture(t);
  const parent = await runtime.startBuild(prompt, new MockProvider(root));
  const merge = { deliveryId: 'delivery-12345678', runId: parent.id, commitSha: 'a'.repeat(40) };
  assert.throws(() => runtime.onPrMerged(merge), /gate is still open/);
  runtime.approveAndVerify(parent.id);
  const continuation = runtime.onPrMerged(merge);
  assert.equal(continuation.stage, 'post_merge_check');
  assert.equal(continuation.status, 'complete');
  assert.equal(runtime.onPrMerged(merge).id, continuation.id);
  assert.equal(store.listRuns().length, 3);
});

test('reference site includes all verified companies, sources and purpose boundary', () => {
  const assets = Object.fromEntries(['index.html', 'styles.css', 'app.js'].map(name => [name, readFileSync(join(root, 'public', name), 'utf8')]));
  const result = checkCandidate(assets, companies);
  assert.equal(result.pass, true, JSON.stringify(result.checks.filter(x => !x.pass)));
});

test('live adapter sends a scoped tool definition and parses a tool call', async t => {
  const oldFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, body: JSON.parse(options.body), auth: options.headers.Authorization };
    return { ok: true, json: async () => ({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write_asset', arguments: '{"path":"index.html","content":"ok"}' } }] } }] }) };
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  const provider = new ChatCompletionsProvider({ apiKey: 'test-only', baseUrl: 'https://example.test/v1', model: 'test-model' });
  const response = await provider.complete([{ role: 'user', content: 'build' }], [{ name: 'write_asset', parameters: { type: 'object' } }]);
  assert.equal(sent.url, 'https://example.test/v1/chat/completions');
  assert.equal(sent.body.model, 'test-model');
  assert.equal(sent.body.tools[0].function.name, 'write_asset');
  assert.equal(response.toolCalls[0].args.path, 'index.html');
});
