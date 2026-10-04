import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class MockProvider {
  constructor(root, variant = 'pass') { this.root = root; this.variant = variant; this.calls = 0; this.name = 'mock'; }
  async complete(messages, tools = []) {
    this.calls++;
    if (tools.length && !messages.some(m => m.role === 'tool')) {
      if (this.variant === 'escape') return { content: '', toolCalls: [{ id: 'mock-1', name: 'write_asset', args: { path: '../escape.txt', content: 'denied' } }] };
      const files = ['index.html', 'styles.css', 'app.js'];
      return { content: '', toolCalls: files.map((name, index) => ({ id: `mock-${index + 1}`, name: 'write_asset', args: { path: name, content: this.variant === 'missing-source' && name === 'index.html' ? '<html lang="zh-Hant-TW"><main><h1>缺少資料來源</h1></main></html>' : readFileSync(join(this.root, 'public', name), 'utf8') } })) };
    }
    if (!tools.length) return { content: JSON.stringify({ verdict: this.variant === 'uncertain' ? 'uncertain' : 'pass', reasons: this.variant === 'uncertain' ? ['來源關係尚待確認'] : ['來源與用途界線清楚'] }), toolCalls: [] };
    return { content: '候選頁面已建立。', toolCalls: [] };
  }
}

export class ChatCompletionsProvider {
  constructor({ apiKey = process.env.LLM_API_KEY, baseUrl = process.env.LLM_BASE_URL, model = process.env.LLM_MODEL } = {}) {
    if (!apiKey || !baseUrl || !model) throw new Error('Live provider requires LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL');
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.name = `live:${model}`;
  }
  async complete(messages, tools = []) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const body = { model: this.model, messages, ...(tools.length ? { tools: tools.map(tool => ({ type: 'function', function: tool })), tool_choice: 'auto' } : {}) };
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`LLM API ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const payload = await response.json();
      const message = payload.choices?.[0]?.message;
      if (!message) throw new Error('LLM API returned no message');
      return {
        content: typeof message.content === 'string' ? message.content : '',
        toolCalls: (message.tool_calls ?? []).map(call => {
          let args;
          try { args = JSON.parse(call.function.arguments); } catch { throw new Error('LLM returned malformed tool arguments'); }
          return { id: call.id, name: call.function.name, args };
        }),
        rawToolCalls: message.tool_calls ?? []
      };
    } finally { clearTimeout(timeout); }
  }
}

export const writeAssetTool = {
  name: 'write_asset',
  description: 'Write one candidate website asset. Only index.html, styles.css, and app.js are allowed.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: { path: { type: 'string', enum: ['index.html', 'styles.css', 'app.js'] }, content: { type: 'string' } },
    required: ['path', 'content']
  }
};
