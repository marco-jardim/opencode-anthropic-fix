export const MODEL = "claude-haiku-4-5-20251001";
export const TEMPERATURE = 0;
export const MAX_TOKENS = 2048;
export const ANTHROPIC_VERSION = "2023-06-01";
export const API_URL = "https://api.anthropic.com/v1/messages";

// Haiku 4.5 pricing as of 2026-04-18 (USD per million tokens).
const PRICE_INPUT_PER_MTOK = 1.0;
const PRICE_OUTPUT_PER_MTOK = 5.0;

export async function callHaiku({ prompt, fetch, getAccessToken }) {
  const token = await getAccessToken();

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Haiku call failed: HTTP ${res.status} ${body}`);
  }

  const json = await res.json();
  const textBlock = (json.content ?? []).find((b) => b.type === "text");
  if (!textBlock || typeof textBlock.text !== "string" || textBlock.text.length === 0) {
    throw new Error("Haiku response has no text content");
  }
  const input = json.usage?.input_tokens ?? 0;
  const output = json.usage?.output_tokens ?? 0;
  const cost = (input / 1e6) * PRICE_INPUT_PER_MTOK + (output / 1e6) * PRICE_OUTPUT_PER_MTOK;

  return { text: textBlock.text, tokens: { input, output }, cost };
}
