// api/process.js — unified proxy for Anthropic and OpenAI.
//
// Request body: { apiKey, prompt, provider?, systemPrompt?, messages?, maxTokens? }
//   provider: 'claude' (default) or 'chatgpt'
//
// Response is always normalized to Anthropic's shape so the client stays simple:
//   { content: [ { type: 'text', text: '...' } ] }
// On error: { error: { message: '...' } } with non-2xx status.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const {
    apiKey,
    prompt,
    provider = 'claude',
    systemPrompt,
    messages,
    maxTokens = 800,
  } = req.body || {};

  if (!apiKey) {
    return res.status(400).json({ error: { message: 'Missing apiKey' } });
  }
  if (!prompt && !(Array.isArray(messages) && messages.length)) {
    return res.status(400).json({ error: { message: 'Missing prompt or messages' } });
  }

  try {
    if (provider === 'chatgpt' || provider === 'openai') {
      return await callOpenAI({ apiKey, prompt, systemPrompt, messages, maxTokens, res });
    }
    // Default to Claude
    return await callAnthropic({ apiKey, prompt, systemPrompt, messages, maxTokens, res });
  } catch (e) {
    console.error('[/api/process] error:', e);
    return res.status(500).json({ error: { message: e.message || 'Internal error' } });
  }
}

async function callAnthropic({ apiKey, prompt, systemPrompt, messages, maxTokens, res }) {
  // Build messages array. Prefer caller-provided messages; otherwise wrap the prompt.
  let msgs = Array.isArray(messages) && messages.length ? [...messages] : [];
  if (prompt) {
    // If caller passed both messages + prompt, the prompt replaces the last user turn
    if (msgs.length && msgs[msgs.length - 1].role === 'user') {
      msgs[msgs.length - 1] = { role: 'user', content: prompt };
    } else {
      msgs.push({ role: 'user', content: prompt });
    }
  }

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: maxTokens,
    messages: msgs,
  };
  if (systemPrompt) body.system = systemPrompt;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await r.json();
  if (!r.ok) {
    return res.status(r.status).json({
      error: { message: data?.error?.message || 'Anthropic error' },
    });
  }
  // Already in Anthropic shape
  return res.status(200).json(data);
}

async function callOpenAI({ apiKey, prompt, systemPrompt, messages, maxTokens, res }) {
  // Convert to OpenAI chat format
  let msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  if (Array.isArray(messages) && messages.length) {
    // Messages from client may already include prior turns
    msgs = msgs.concat(messages);
  }
  if (prompt) {
    // Replace last user turn if present, else append
    if (msgs.length && msgs[msgs.length - 1].role === 'user') {
      msgs[msgs.length - 1] = { role: 'user', content: prompt };
    } else {
      msgs.push({ role: 'user', content: prompt });
    }
  }

  const body = {
    model: 'gpt-4o-mini',
    messages: msgs,
    max_tokens: maxTokens,
    temperature: 0.7,
  };

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await r.json();
  if (!r.ok) {
    return res.status(r.status).json({
      error: { message: data?.error?.message || 'OpenAI error' },
    });
  }

  // Normalize to Anthropic shape so client code can use data.content[0].text
  const text = data?.choices?.[0]?.message?.content || '';
  return res.status(200).json({
    content: [{ type: 'text', text }],
    // Preserve usage info in case anything cares
    usage: data.usage,
    model: data.model,
  });
}
