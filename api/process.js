export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { prompt, apiKey, systemPrompt, messages, maxTokens } = req.body;

  // Build messages array - support both simple prompt and multi-turn
  let msgArray = messages && messages.length > 0 
    ? messages 
    : [{ role: 'user', content: prompt }];

  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens || 1000,
    messages: msgArray,
  };

  if (systemPrompt) body.system = systemPrompt;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  res.status(200).json(data);
}
