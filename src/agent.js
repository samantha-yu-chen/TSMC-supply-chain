import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkill, stageDefinition, validateToolCall } from './policy.js';
import { writeAssetTool } from './provider.js';

export async function buildWithAgent({ root, store, run, provider, companies }) {
  const skill = loadSkill(root);
  const messages = [
    { role: 'system', content: `${skill}\nYou have a maximum of ${stageDefinition.maxToolCalls} tool calls. Work only from the supplied source data.` },
    { role: 'user', content: `Task: ${run.prompt}\nVerified representative companies and sources:\n${JSON.stringify(companies, null, 2)}` }
  ];
  let callCount = 0;
  for (let turn = 0; turn < 8; turn++) {
    const response = await provider.complete(messages, [writeAssetTool]);
    if (!response.toolCalls.length) return { message: response.content, toolCalls: callCount };
    messages.push({ role: 'assistant', content: response.content || null, tool_calls: response.rawToolCalls ?? response.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
    for (const call of response.toolCalls) {
      if (++callCount > stageDefinition.maxToolCalls) throw new Error('Tool-call budget exhausted');
      validateToolCall(call);
      const artifact = store.putArtifact(run, call.args.path, call.args.content);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ ok: true, path: call.args.path, hash: artifact.hash }) });
    }
  }
  throw new Error('Agent turn budget exhausted');
}

export async function reviewWithAgent({ root, provider, assets, companies }) {
  const skill = readFileSync(join(root, 'skills/review-page.md'), 'utf8');
  const response = await provider.complete([
    { role: 'system', content: `${skill}\nReturn only JSON: {"verdict":"pass|fail|uncertain","reasons":["..."]}.` },
    { role: 'user', content: `Sources:\n${JSON.stringify(companies)}\nCandidate HTML:\n${(assets['index.html'] ?? '').slice(0, 60_000)}` }
  ]);
  try {
    const json = JSON.parse(response.content);
    if (!['pass', 'fail', 'uncertain'].includes(json.verdict) || !Array.isArray(json.reasons)) throw new Error('Invalid semantic verdict');
    return { verdict: json.verdict, reasons: json.reasons.map(String).slice(0, 8) };
  } catch { return { verdict: 'uncertain', reasons: ['Semantic checker returned invalid output'] }; }
}
