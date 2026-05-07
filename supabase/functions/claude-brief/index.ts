const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response("Server misconfigured: ANTHROPIC_API_KEY not set", {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON body", {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  const payload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 4096,
    ...(body.system ? { system: body.system } : {}),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    messages: body.messages ?? [],
  };

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return new Response(`Upstream request failed: ${err instanceof Error ? err.message : String(err)}`, {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(`Anthropic API error ${anthropicRes.status}: ${errText}`, {
      status: anthropicRes.status,
      headers: { ...corsHeaders, "Content-Type": "text/plain" },
    });
  }

  const data = await anthropicRes.json();
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((block: { type?: string }) => block?.type === "text")
        .map((block: { text?: string }) => block.text ?? "")
        .join("")
    : "";

  return new Response(text, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
  });
});
