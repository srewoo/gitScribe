/**
 * Exact token counting, where a vendor actually offers it.
 *
 * This is the one thing an API key buys: replacing GitScribe's byte-density
 * estimate with a real count. It is deliberately NOT wired to every checkbox
 * toggle — each count is a network call against a rate-limited endpoint and
 * sends the digest to the vendor, so it runs only when the user asks.
 *
 * Only two vendors can do this at all. See EXACT_SUPPORT for why.
 */

export type Provider = 'anthropic' | 'google' | 'openai' | 'xai';

export interface ProviderSupport {
  readonly provider: Provider;
  readonly label: string;
  readonly exact: boolean;
  /** Shown in settings. Honesty here is the point. */
  readonly note: string;
}

export const EXACT_SUPPORT: readonly ProviderSupport[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    exact: true,
    note: 'Exact counts via the count_tokens endpoint. The key is only ever used for counting.',
  },
  {
    provider: 'google',
    label: 'Google',
    exact: true,
    note: 'Exact counts via the Gemini countTokens endpoint.',
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    exact: false,
    note:
      'OpenAI publishes no token-counting endpoint, so a key cannot buy an exact ' +
      'count. Exact GPT counts need the tiktoken tokenizer bundled locally ' +
      '(~1MB, lazy-loaded) — not a key. Estimates are used meanwhile.',
  },
  {
    provider: 'xai',
    label: 'xAI (Grok)',
    exact: false,
    note:
      'No token-counting endpoint confirmed in xAI’s own documentation. Rather ' +
      'than call a guessed endpoint, GitScribe uses estimates for Grok and says so.',
  },
];

export interface ExactCount {
  readonly tokens: number;
  readonly provider: Provider;
  readonly model: string;
}

export class CountUnsupportedError extends Error {}

/**
 * Count with Anthropic's count_tokens. Runs in the background service worker,
 * where host_permissions exempt it from CORS; the SDK still needs the browser
 * flag because it detects a browser-like global scope.
 */
async function countAnthropic(apiKey: string, model: string, text: string): Promise<number> {
  // Imported lazily: the SDK is ~500KB and would otherwise be parsed on every
  // service-worker wake, for a feature most sessions never touch.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const res = await client.messages.countTokens({
    model,
    messages: [{ role: 'user', content: text }],
  });
  return res.input_tokens;
}

/** Count with the Gemini countTokens endpoint. */
async function countGoogle(apiKey: string, model: string, text: string): Promise<number> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:countTokens`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
  });
  if (!res.ok) {
    throw new Error(`Google countTokens failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { totalTokens?: number };
  if (typeof body.totalTokens !== 'number') throw new Error('Google returned no totalTokens.');
  return body.totalTokens;
}

/** Which provider owns a model id from the registry. */
export function providerOf(modelId: string): Provider | null {
  if (modelId.startsWith('claude-')) return 'anthropic';
  if (modelId.startsWith('gemini-')) return 'google';
  if (modelId.startsWith('gpt-')) return 'openai';
  if (modelId.startsWith('grok-')) return 'xai';
  return null; // local Ollama models and anything unrecognised
}

export async function countExact(
  provider: Provider,
  apiKey: string,
  model: string,
  text: string,
): Promise<ExactCount> {
  const support = EXACT_SUPPORT.find((s) => s.provider === provider);
  if (!support?.exact) {
    throw new CountUnsupportedError(support?.note ?? `No exact counting for ${provider}.`);
  }
  const tokens =
    provider === 'anthropic'
      ? await countAnthropic(apiKey, model, text)
      : await countGoogle(apiKey, model, text);
  return { tokens, provider, model };
}
