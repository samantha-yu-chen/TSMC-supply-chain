import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWithAgent, reviewWithAgent } from './agent.js';
import { checkCandidate, allowedAssets } from './policy.js';

export class HarnessRuntime {
  constructor({ root, store, companies, publishRoot = join(root, 'storage', 'published') }) { this.root = root; this.store = store; this.companies = companies; this.publishRoot = publishRoot; }
  assets(runId) { return Object.fromEntries(allowedAssets.map(name => [name, this.store.readArtifact(runId, name)])); }
  async startBuild(prompt, provider, scope = {}) {
    if (typeof prompt !== 'string' || prompt.trim().length < 20 || prompt.length > 3000) throw new Error('Prompt must be 20–3000 characters');
    const run = this.store.createRun({ stage: 'slice_a_build', prompt: prompt.trim(), provider: provider.name, ...scope });
    try {
      const agent = await buildWithAgent({ root: this.root, store: this.store, run, provider, companies: this.companies });
      const assets = this.assets(run.id);
      const deterministic = checkCandidate(assets, this.companies);
      this.store.event(run.id, 'checks.deterministic', deterministic);
      if (!deterministic.pass) return this.store.transition(run.id, 'running', 'held', { checks: { deterministic, agent }, error: 'Deterministic checks failed' });
      const semantic = await reviewWithAgent({ root: this.root, provider, assets, companies: this.companies });
      this.store.event(run.id, 'checks.semantic', semantic);
      if (semantic.verdict === 'fail') return this.store.transition(run.id, 'running', 'held', { checks: { deterministic, semantic, agent }, error: 'Semantic check failed' });
      return this.store.transition(run.id, 'running', 'awaiting_approval', { checks: { deterministic, semantic, agent } });
    } catch (error) {
      return this.store.transition(run.id, 'running', 'held', { error: error.message });
    }
  }
  approveAndVerify(parentId, actor = 'owner') {
    const parent = this.store.getRun(parentId);
    if (!parent || parent.stage !== 'slice_a_build') throw new Error('Unknown Slice A run');
    const previousChild = this.store.db.prepare('SELECT id FROM runs WHERE parent_id=? ORDER BY created_at DESC LIMIT 1').get(parentId);
    if (previousChild) return this.store.getRun(previousChild.id);
    if (parent.status !== 'awaiting_approval') throw new Error(`Run is ${parent.status}, not awaiting approval`);
    this.store.transition(parentId, 'awaiting_approval', 'approved');
    this.store.event(parentId, 'approval.granted', { actor });
    const child = this.store.createRun({ parentId, tenantId: parent.tenant_id, productId: parent.product_id, stage: 'slice_b_verify', prompt: 'Verify and publish approved candidate', provider: 'deterministic' });
    try {
      const assets = this.assets(parentId);
      const deterministic = checkCandidate(assets, this.companies);
      if (!deterministic.pass) return this.store.transition(child.id, 'running', 'held', { checks: { deterministic }, error: 'Slice B verification failed' });
      const publishRoot = join(this.publishRoot, child.id);
      mkdirSync(publishRoot, { recursive: true });
      for (const name of allowedAssets) writeFileSync(join(publishRoot, name), assets[name], { flag: 'wx' });
      this.store.event(child.id, 'artifact.published', { parentId, path: publishRoot });
      return this.store.transition(child.id, 'running', 'complete', { checks: { deterministic } });
    } catch (error) {
      return this.store.transition(child.id, 'running', 'held', { error: error.message });
    }
  }
  reject(parentId, actor = 'owner') {
    const parent = this.store.getRun(parentId);
    if (!parent || parent.status !== 'awaiting_approval') throw new Error('Run is not awaiting approval');
    this.store.event(parentId, 'approval.rejected', { actor });
    return this.store.transition(parentId, 'awaiting_approval', 'rejected');
  }
  onPrMerged({ deliveryId, runId, commitSha }) {
    if (!/^[a-zA-Z0-9_-]{8,120}$/.test(deliveryId || '') || !/^[a-f0-9]{40}$/.test(commitSha || '')) throw new Error('Invalid merge event');
    const existing = this.store.mergeEvent(deliveryId, runId, commitSha);
    if (existing) return this.store.getRun(existing.continuation_id);
    const approved = this.store.getRun(runId);
    if (!approved || approved.stage !== 'slice_a_build' || approved.status !== 'approved') throw new Error('Owner gate is still open');
    const sliceB = this.store.db.prepare("SELECT * FROM runs WHERE parent_id=? AND stage='slice_b_verify' ORDER BY created_at DESC LIMIT 1").get(runId);
    if (!sliceB || sliceB.status !== 'complete') throw new Error('Slice B is not complete');
    const continuation = this.store.createRun({ parentId: sliceB.id, tenantId: approved.tenant_id, productId: approved.product_id, stage: 'post_merge_check', prompt: `Verify merged commit ${commitSha}`, provider: 'deterministic' });
    const assets = this.assets(runId);
    const deterministic = checkCandidate(assets, this.companies);
    this.store.recordMerge(deliveryId, runId, commitSha, continuation.id);
    return this.store.transition(continuation.id, 'running', deterministic.pass ? 'complete' : 'held', { checks: { deterministic }, error: deterministic.pass ? null : 'Post-merge check failed' });
  }
}
