const $ = selector => document.querySelector(selector);
let activeRun = null;
let childRun = null;

function token() {
  const value = $('#owner-token').value.trim();
  if (!value) throw new Error('請填入 server 啟動時顯示的 owner token。');
  return value;
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'X-Owner-Token': token(), ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function status(label, kind = '') { $('#run-status').textContent = label; $('#run-status').className = `pill ${kind}`; }
function stage(id, state) { const el = $(`#stage-${id}`); el.classList.remove('active', 'done'); if (state) el.classList.add(state); }
function eventLine(title, detail, fail = false) {
  const line = document.createElement('div'); line.className = `event${fail ? ' fail' : ''}`;
  const strong = document.createElement('strong'); strong.textContent = title;
  const p = document.createElement('p'); p.textContent = detail;
  line.append(strong, p); $('#events').append(line);
}
function displayRun(run) {
  activeRun = run;
  $('#events').replaceChildren();
  const deterministic = run.checks?.deterministic;
  if (deterministic) for (const check of deterministic.checks) eventLine(`${check.pass ? '✓' : '×'} ${check.id}`, check.detail, !check.pass);
  if (run.checks?.semantic) eventLine(`Semantic：${run.checks.semantic.verdict}`, run.checks.semantic.reasons.join('；'), run.checks.semantic.verdict === 'fail');
  if (run.error) eventLine('流程已停止', run.error, true);
  if (run.status === 'awaiting_approval') { status('等待你核准', 'warn'); stage('build', 'done'); stage('gate', 'active'); }
  else if (run.status === 'held') { status('已停等', 'bad'); stage('build', 'active'); }
  else status(run.status);
  const panel = $('#artifact-panel'); panel.replaceChildren();
  const result = document.createElement('div'); result.className = 'result';
  const title = document.createElement('h3'); title.textContent = 'Slice A 候選頁面'; result.append(title);
  const info = document.createElement('p'); info.textContent = run.status === 'awaiting_approval' ? '檢查完成。此處是硬停止；你的核准會啟動新的 Slice B task。' : '請查看檢查結果，修正任務後可重新執行。'; result.append(info);
  const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `Run ${run.id}`; result.append(meta);
  if (run.checks?.deterministic?.pass) {
    const frame = document.createElement('div'); frame.className = 'preview';
    const iframe = document.createElement('iframe'); iframe.setAttribute('sandbox', ''); iframe.title = '候選頁面預覽'; iframe.src = `/api/runs/${run.id}/preview`; frame.append(iframe); result.append(frame);
  }
  if (run.status === 'awaiting_approval') {
    const gate = document.createElement('div'); gate.className = 'gate';
    const strong = document.createElement('strong'); strong.textContent = '等待 owner 核准';
    const p = document.createElement('p'); p.textContent = '在你核准前，Slice B 不會建立，也不會執行任何後續檢查。';
    const approve = document.createElement('button'); approve.className = 'approve-button'; approve.textContent = '核准並開始 Slice B'; approve.addEventListener('click', approveRun);
    gate.append(strong, p, approve); result.append(gate);
  }
  panel.append(result);
}
async function approveRun() {
  if (!activeRun) return;
  try {
    childRun = await api(`/api/runs/${activeRun.id}/approve`, { method: 'POST', body: '{}' });
    status(childRun.status === 'complete' ? 'Slice B 完成' : 'Slice B 停等', childRun.status === 'complete' ? 'good' : 'bad');
    stage('gate', 'done'); stage('verify', childRun.status === 'complete' ? 'done' : 'active');
    eventLine('Slice B 新 task', `新 Run ${childRun.id}，重新執行 ${childRun.checks?.deterministic?.checks.length || 0} 項檢查。`);
    const box = document.createElement('div'); box.className = 'child-task';
    const title = document.createElement('strong'); title.textContent = 'Slice B · 獨立驗證';
    const detail = document.createElement('p'); detail.textContent = `狀態：${childRun.status}。新 task ID：${childRun.id}`;
    box.append(title, detail); $('#artifact-panel .result').append(box);
    $('#artifact-panel .gate')?.remove();
  } catch (error) { eventLine('核准失敗', error.message, true); }
}
$('#run-button').addEventListener('click', async () => {
  const button = $('#run-button'); button.disabled = true;
  status('Slice A 執行中'); $('#events').replaceChildren(); eventLine('Agent 開始建置', '載入 skill、來源與受限工具。');
  try {
    const run = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: $('#prompt').value, provider: $('#provider').value }) });
    displayRun(run);
  } catch (error) { status('無法啟動', 'bad'); eventLine('錯誤', error.message, true); }
  finally { button.disabled = false; }
});
