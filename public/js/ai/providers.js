// Talking to language models straight from the browser with the user's own API key.
//
// Parter has no backend, so a hosted copy never sees anyone's key or plan: requests go from
// the browser to the provider. Two wire formats are supported:
//   - 'anthropic'  the Claude Messages API
//   - 'openai'     the Chat Completions format, which OpenAI, OpenRouter, Ollama, LM Studio,
//                  Gemini's compatibility endpoint and many others speak
//
// Both are driven through one neutral conversation shape:
//   { role: 'user', text, images?: [{ mime, b64 }] }
//   { role: 'assistant', text, calls: [{ id, name, args }] }
//   { role: 'tool', results: [{ id, name, text }] }

export const PRESETS = {
  anthropic: { label: 'Claude (Anthropic)', format: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', keyHint: 'sk-ant-…' },
  openai: { label: 'OpenAI', format: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', keyHint: 'sk-…' },
  openrouter: { label: 'OpenRouter', format: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '', keyHint: 'sk-or-…' },
  gemini: { label: 'Gemini (OpenAI-compatible)', format: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', keyHint: 'AIza…' },
  local: { label: 'Local model (Ollama, LM Studio)', format: 'openai', baseUrl: 'http://localhost:11434/v1', model: '', keyHint: 'not needed' }
};

export class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function post(url, headers, body, { signal, fetchFn } = {}) {
  let res;
  try { res = await (fetchFn || fetch)(url, { method: 'POST', headers, body: typeof body === 'string' || body instanceof FormData ? body : JSON.stringify(body), signal }); }
  catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ProviderError('Could not reach ' + new URL(url).host + '. Check the address, your connection, and that the provider allows calls from a browser.', 0);
  }
  let data = null, text = '';
  try { text = await res.text(); data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const msg = (data && (data.error && (data.error.message || data.error) || data.message)) || text.slice(0, 300) || res.statusText;
    throw new ProviderError((res.status === 401 || res.status === 403 ? 'The API key was not accepted. ' : '') + `${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status);
  }
  return data;
}

// ---------- Anthropic ----------
function toAnthropic(messages) {
  return messages.map(m => {
    if (m.role === 'user') return { role: 'user', content: [...(m.images || []).map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.b64 } })), { type: 'text', text: m.text || '' }] };
    if (m.role === 'assistant') {
      const c = []; if (m.text) c.push({ type: 'text', text: m.text });
      for (const k of m.calls || []) c.push({ type: 'tool_use', id: k.id, name: k.name, input: k.args || {} });
      return { role: 'assistant', content: c.length ? c : [{ type: 'text', text: '…' }] };
    }
    return { role: 'user', content: m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: r.text })) };
  });
}
async function anthropicStep(cfg, { system, messages, tools, forceTool, maxTokens, signal, fetchFn }) {
  const body = { model: cfg.model, max_tokens: maxTokens || 4096, system, messages: toAnthropic(messages) };
  if (tools && tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  if (forceTool) body.tool_choice = { type: 'tool', name: forceTool };
  const data = await post(cfg.baseUrl.replace(/\/$/, '') + '/messages', {
    'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'            // the provider's opt-in for bring-your-own-key browser apps
  }, body, { signal, fetchFn });
  const blocks = (data && data.content) || [];
  return {
    text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(),
    calls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input || {} })),
    stop: data && data.stop_reason
  };
}

// ---------- OpenAI-compatible ----------
function toOpenAI(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: (m.images && m.images.length) ? [{ type: 'text', text: m.text || '' }, ...m.images.map(i => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.b64}` } }))] : (m.text || '') });
    } else if (m.role === 'assistant') {
      const a = { role: 'assistant', content: m.text || null };
      if (m.calls && m.calls.length) a.tool_calls = m.calls.map(k => ({ id: k.id, type: 'function', function: { name: k.name, arguments: JSON.stringify(k.args || {}) } }));
      out.push(a);
    } else for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.text });
  }
  return out;
}
async function openaiStep(cfg, { system, messages, tools, forceTool, signal, fetchFn }) {
  const body = { model: cfg.model, messages: toOpenAI(system, messages) };
  if (tools && tools.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (forceTool) body.tool_choice = { type: 'function', function: { name: forceTool } };
  const headers = { 'content-type': 'application/json' };
  if (cfg.key) headers.authorization = 'Bearer ' + cfg.key;
  const data = await post(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', headers, body, { signal, fetchFn });
  const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
  const calls = (msg.tool_calls || []).filter(k => k.function).map((k, n) => {
    let args = {}; try { args = k.function.arguments ? JSON.parse(k.function.arguments) : {}; } catch (e) { args = { _unparsed: k.function.arguments }; }
    return { id: k.id || 'call_' + n, name: k.function.name, args };
  });
  const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(p => p.text || '').join('') : '';
  return { text: text.trim(), calls, stop: data && data.choices && data.choices[0] && data.choices[0].finish_reason };
}

/** One model turn. Returns { text, calls, stop }. */
export function modelStep(cfg, req) {
  if (!cfg || !cfg.model) throw new ProviderError('Choose a model in Settings first.', 0);
  if (cfg.format === 'anthropic') {
    if (!cfg.key) throw new ProviderError('Add your API key in Settings first.', 0);
    return anthropicStep(cfg, req);
  }
  return openaiStep(cfg, req);
}

// ---------- image generation ----------
export const IMAGE_PRESETS = {
  openai: { label: 'OpenAI images', model: 'gpt-image-2', keyHint: 'sk-…' },
  gemini: { label: 'Gemini images', model: 'gemini-3.1-flash-image', keyHint: 'AIza…' }
};

const b64ToBlob = (b64, mime) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: mime }); };

/**
 * Send reference pictures plus a prompt, get one picture back as a data URL.
 * @param cfg    { provider: 'openai'|'gemini', key, model }
 * @param images [{ mime, b64, name }]  the first is the main reference (the colour view)
 */
export async function generateImage(cfg, { prompt, images, size, signal, fetchFn }) {
  if (!cfg || !cfg.key) throw new ProviderError('Add an image API key in Settings first.', 0);
  if (cfg.provider === 'gemini') {
    const data = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`,
      { 'content-type': 'application/json', 'x-goog-api-key': cfg.key },
      { contents: [{ parts: [{ text: prompt }, ...images.map(i => ({ inline_data: { mime_type: i.mime, data: i.b64 } }))] }] }, { signal, fetchFn });
    const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const img = parts.map(p => p.inlineData || p.inline_data).find(Boolean);
    if (!img) throw new ProviderError('The model answered without a picture: ' + (parts.map(p => p.text || '').join(' ').slice(0, 200) || 'empty reply'), 200);
    return `data:${img.mimeType || img.mime_type || 'image/png'};base64,${img.data}`;
  }
  const form = new FormData();
  form.append('model', cfg.model); form.append('prompt', prompt);
  if (size) form.append('size', size);
  images.forEach((i, n) => form.append(images.length > 1 ? 'image[]' : 'image', b64ToBlob(i.b64, i.mime), i.name || `reference-${n + 1}.png`));
  const data = await post('https://api.openai.com/v1/images/edits', { authorization: 'Bearer ' + cfg.key }, form, { signal, fetchFn });
  const d = data && data.data && data.data[0];
  if (!d || !(d.b64_json || d.url)) throw new ProviderError('The image service returned no picture.', 200);
  return d.b64_json ? 'data:image/png;base64,' + d.b64_json : d.url;
}
