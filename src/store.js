import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();

export class Store {
  constructor(dbPath, blobRoot) {
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(blobRoot, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.blobRoot = blobRoot;
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, parent_id TEXT, tenant_id TEXT NOT NULL, product_id TEXT NOT NULL,
        stage TEXT NOT NULL, status TEXT NOT NULL, prompt TEXT NOT NULL,
        provider TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        checks TEXT, error TEXT, artifact_id TEXT,
        FOREIGN KEY(parent_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL,
        payload TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        product_id TEXT NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL,
        bytes INTEGER NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(run_id,name), FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS merge_events (
        delivery_id TEXT PRIMARY KEY, run_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL, continuation_id TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(run_id,commit_sha),
        FOREIGN KEY(run_id) REFERENCES runs(id),
        FOREIGN KEY(continuation_id) REFERENCES runs(id)
      );
    `);
  }
  createRun({ parentId = null, tenantId = 'demo', productId = 'tsmc-supply-chain', stage, prompt, provider }) {
    const id = randomUUID();
    const time = now();
    this.db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, parentId, tenantId, productId, stage, 'running', prompt, provider, time, time, null, null, null);
    this.event(id, 'run.started', { stage, parentId });
    return this.getRun(id);
  }
  getRun(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    return row ? { ...row, checks: row.checks ? JSON.parse(row.checks) : null } : null;
  }
  listRuns(limit = 30) {
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit).map(row => ({ ...row, checks: row.checks ? JSON.parse(row.checks) : null }));
  }
  updateRun(id, status, extras = {}) {
    const old = this.getRun(id);
    if (!old) throw new Error('Unknown run');
    const checks = extras.checks === undefined ? old.checks : extras.checks;
    const error = extras.error === undefined ? old.error : extras.error;
    const artifactId = extras.artifactId === undefined ? old.artifact_id : extras.artifactId;
    this.db.prepare('UPDATE runs SET status=?,updated_at=?,checks=?,error=?,artifact_id=? WHERE id=?').run(status, now(), checks ? JSON.stringify(checks) : null, error, artifactId, id);
    this.event(id, `run.${status}`, { from: old.status, ...extras });
    return this.getRun(id);
  }
  transition(id, expected, next, extras = {}) {
    const run = this.getRun(id);
    if (!run || run.status !== expected) throw new Error(`Expected ${expected}, found ${run?.status ?? 'missing'}`);
    return this.updateRun(id, next, extras);
  }
  event(runId, kind, payload = {}) {
    this.db.prepare('INSERT INTO events VALUES (?,?,?,?,?)').run(randomUUID(), runId, kind, JSON.stringify(payload), now());
  }
  events(runId) {
    return this.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY created_at,id').all(runId).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  putArtifact(run, name, content) {
    if (!['index.html', 'styles.css', 'app.js'].includes(name)) throw new Error('Artifact name denied');
    const buffer = Buffer.from(content, 'utf8');
    const hash = createHash('sha256').update(buffer).digest('hex');
    const id = randomUUID();
    const blobPath = join(this.blobRoot, hash);
    if (!existsSync(blobPath)) writeFileSync(blobPath, buffer, { flag: 'wx' });
    this.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(run_id,name) DO UPDATE SET id=excluded.id,hash=excluded.hash,bytes=excluded.bytes,created_at=excluded.created_at').run(id, run.id, run.tenant_id, run.product_id, name, hash, buffer.length, now());
    this.event(run.id, 'artifact.written', { name, hash, bytes: buffer.length });
    return { id, hash, bytes: buffer.length };
  }
  artifacts(runId) {
    return this.db.prepare('SELECT * FROM artifacts WHERE run_id=? ORDER BY name').all(runId);
  }
  readArtifact(runId, name) {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE run_id=? AND name=?').get(runId, name);
    if (!row) return null;
    const content = readFileSync(join(this.blobRoot, row.hash), 'utf8');
    if (createHash('sha256').update(content).digest('hex') !== row.hash) throw new Error('Artifact hash mismatch');
    return content;
  }
  mergeEvent(deliveryId, runId, commitSha) {
    return this.db.prepare('SELECT * FROM merge_events WHERE delivery_id=? OR (run_id=? AND commit_sha=?)').get(deliveryId, runId, commitSha) ?? null;
  }
  recordMerge(deliveryId, runId, commitSha, continuationId) {
    this.db.prepare('INSERT INTO merge_events VALUES (?,?,?,?,?)').run(deliveryId, runId, commitSha, continuationId, now());
    this.event(continuationId, 'pr.merged', { deliveryId, commitSha, runId });
  }
  close() { this.db.close(); }
}
