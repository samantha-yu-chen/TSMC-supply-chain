import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const allowedAssets = Object.freeze(['index.html', 'styles.css', 'app.js']);
export const stageDefinition = Object.freeze({
  id: 'build_intro_page', version: '1.0.0',
  skill: 'skills/build-intro-page.md',
  tools: ['write_asset'],
  maxToolCalls: 9, maxAssetBytes: 100_000,
  writeSet: allowedAssets,
  gate: 'owner_release_approval'
});

export function validateToolCall(call) {
  if (call?.name !== 'write_asset') throw new Error('Tool denied');
  if (!call.args || Object.keys(call.args).sort().join(',') !== 'content,path') throw new Error('Invalid tool arguments');
  if (!allowedAssets.includes(call.args.path)) throw new Error('Write outside granted assets');
  if (typeof call.args.content !== 'string' || Buffer.byteLength(call.args.content) > stageDefinition.maxAssetBytes) throw new Error('Invalid asset content');
  if (/(<script[^>]+src\s*=\s*["']https?:|@import\s+url\(\s*["']?https?:)/i.test(call.args.content)) throw new Error('Remote executable asset denied');
  return call;
}

export function checkCandidate(assets, companies) {
  const checks = [];
  const add = (id, pass, detail) => checks.push({ id, pass: Boolean(pass), detail });
  const html = assets['index.html'] ?? '';
  const css = assets['styles.css'] ?? '';
  const js = assets['app.js'] ?? '';
  add('assets.complete', allowedAssets.every(name => typeof assets[name] === 'string' && assets[name].length > 0), 'HTML、CSS、JS 三個檔案都必須存在');
  add('html.semantic', /<html\b[^>]*lang=["']zh-Hant(?:-TW)?["']/i.test(html) && /<main\b/i.test(html) && /<h1\b/i.test(html), '語言、main 與 h1');
  add('html.responsive', /name=["']viewport["']/i.test(html), 'viewport meta');
  add('a11y.focus', /:focus-visible/.test(css) && /prefers-reduced-motion/.test(css), '鍵盤焦點與降低動態效果');
  add('sources.present', companies.every(c => html.includes(c.source)), '每家公司都有原始資料連結');
  add('companies.present', companies.every(c => html.includes(c.name) && html.includes(c.ticker)), '五家公司名稱與代號');
  add('scope.note', /不代表|示意|非.*供貨/.test(html) && /不提供|非投資建議|不構成投資建議/.test(html), '供應關係與投資用途界線');
  add('no.remote.code', !/<script[^>]+src\s*=\s*["']https?:/i.test(html) && !/@import\s+url\(\s*["']?https?:/i.test(css), '沒有遠端可執行資產');
  add('links.safe', !/target=["']_blank["'](?![^>]*rel=["'][^"']*noopener)/i.test(html), '新視窗連結含 noopener');
  add('js.bounded', Buffer.byteLength(js) <= stageDefinition.maxAssetBytes, 'JS 大小限制');
  return { pass: checks.every(c => c.pass), checks };
}

export function loadSkill(root) { return readFileSync(join(root, stageDefinition.skill), 'utf8'); }
