import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { Store } from './store.js';
import { HarnessRuntime } from './runtime.js';
import { MockProvider, ChatCompletionsProvider } from './provider.js';

const root = resolve(import.meta.dirname, '..');
const publicRoot = join(root, 'public');
const store = new Store(join(root, 'storage', 'harness.sqlite'), join(root, 'storage', 'blobs'));
const companies = JSON.parse(readFileSync(join(root, 'data', 'companies.json'))).companies;
const runtime = new HarnessRuntime({ root, store, companies });
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const ownerToken = process.env.OWNER_TOKEN || randomBytes(24).toString('hex');

function send(res, status, body, type = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}
function authorized(req) {
  const value = req.headers['x-owner-token'];
  if (typeof value !== 'string') return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(ownerToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
async function readRaw(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Request too large');
  }
  return raw;
}
async function readJson(req) { return JSON.parse((await readRaw(req)) || '{}'); }
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/harness', ['harness.html', 'text/html; charset=utf-8']],
  ['/harness.css', ['harness.css', 'text/css; charset=utf-8']],
  ['/harness.js', ['harness.js', 'text/javascript; charset=utf-8']]
]);

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  try {
    if (req.method === 'GET' && staticFiles.has(pathname)) {
      const [file, type] = staticFiles.get(pathname);
      return send(res, 200, readFileSync(join(publicRoot, file)), type, { 'Cache-Control': 'public, max-age=300' });
    }
    if (req.method === 'GET' && pathname === '/api/runs') return send(res, 200, store.listRuns());
    const runMatch = pathname.match(/^\/api\/runs\/([a-f0-9-]+)$/);
    if (req.method === 'GET' && runMatch) {
      const run = store.getRun(runMatch[1]);
      return run ? send(res, 200, { ...run, events: store.events(run.id), artifacts: store.artifacts(run.id) }) : send(res, 404, { error: 'Run not found' });
    }
    const previewMatch = pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/preview$/);
    if (req.method === 'GET' && previewMatch) {
      const html = store.readArtifact(previewMatch[1], 'index.html');
      const css = store.readArtifact(previewMatch[1], 'styles.css');
      if (!html || !css) return send(res, 404, 'No candidate', 'text/plain; charset=utf-8');
      const preview = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, '').replace('</head>', `<style>${css.replace(/<\/style/gi, '<\\/style')}</style></head>`);
      return send(res, 200, preview, 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; sandbox" });
    }
    if (req.method === 'POST' && pathname === '/api/runs') {
      if (!authorized(req)) return send(res, 403, { error: 'Owner token required' });
      const body = await readJson(req);
      const provider = body.provider === 'live' ? new ChatCompletionsProvider() : new MockProvider(root, body.variant || 'pass');
      const run = await runtime.startBuild(body.prompt, provider);
      return send(res, 200, run);
    }
    if (req.method === 'POST' && pathname === '/api/webhooks/github') {
      const secret = process.env.GITHUB_WEBHOOK_SECRET;
      if (!secret) return send(res, 503, { error: 'Webhook secret is not configured' });
      const raw = await readRaw(req);
      const given = String(req.headers['x-hub-signature-256'] || '');
      const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
      const a = Buffer.from(given), b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return send(res, 403, { error: 'Invalid webhook signature' });
      const body = JSON.parse(raw);
      if (body.action !== 'closed' || body.pull_request?.merged !== true || body.pull_request?.base?.ref !== 'main') return send(res, 202, { ignored: true });
      const marker = String(body.pull_request?.body || '').match(/Harness-Run:\s*([a-f0-9-]{36})/i);
      if (!marker) return send(res, 202, { ignored: true });
      const run = runtime.onPrMerged({ deliveryId: String(req.headers['x-github-delivery'] || ''), runId: marker[1], commitSha: body.pull_request.merge_commit_sha });
      return send(res, 202, { continuationId: run.id, status: run.status });
    }
    const actionMatch = pathname.match(/^\/api\/runs\/([a-f0-9-]+)\/(approve|reject)$/);
    if (req.method === 'POST' && actionMatch) {
      if (!authorized(req)) return send(res, 403, { error: 'Owner token required' });
      const result = actionMatch[2] === 'approve' ? runtime.approveAndVerify(actionMatch[1]) : runtime.reject(actionMatch[1]);
      return send(res, 200, result);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    return send(res, 400, { error: error.message });
  }
});
server.listen(port, host, () => {
  process.stdout.write(`TSMC supply chain: http://${host}:${port}\nHarness Lab: http://${host}:${port}/harness\nOwner token: ${ownerToken}\n`);
});
