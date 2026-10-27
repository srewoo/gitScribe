/**
 * Provider-agnostic completion, used to turn code into documentation.
 *
 * Every call here sends repository content to a third party. That is a real
 * change from the rest of GitScribe, which never sends code anywhere, and the
 * UI must say so before the first call rather than after.
 *
 * The Anthropic path uses the official SDK; the others are plain HTTP because
 * bundling three more SDKs into a service worker is not worth it.
 */

import { lookupModel, modelsFor, estimateFromText } from '@gitscribe/core';

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'xai' | 'ollama';

export interface ModelChoice {
  readonly provider: ProviderId;
  readonly model: string;
  /** Context window the user entered for a model we have no verified figure for. */
  readonly contextWindow?: number;
}

export interface Completion {
  readonly text: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CompleteArgs {
  readonly choice: ModelChoice;
  readonly apiKey: string;
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
  readonly signal?: AbortSignal;
}

export interface ProviderInfo {
  readonly id: ProviderId;
  readonly label: string;
  readonly needsKey: boolean;
  readonly keyHint: string;
  /** Suggested models. The user may type any model id instead. */
  readonly models: readonly string[];
}

/** Registry models first (known windows), then other common ids to type less. */
const suggest = (id: ProviderId, extra: readonly string[] = []): string[] =>
  [...modelsFor(id).map((m) => m.id), ...extra];

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    needsKey: true,
    keyHint: 'sk-ant-…',
    models: suggest('anthropic'),
  },
  {
    id: 'openai',
    label: 'OpenAI',
    needsKey: true,
    keyHint: 'sk-…',
    models: suggest('openai', ['gpt-5-mini', 'gpt-4.1-mini']),
  },
  {
    id: 'google',
    label: 'Google',
    needsKey: true,
    keyHint: 'AIza…',
    models: suggest('google', ['gemini-2.5-flash']),
  },
  {
    id: 'xai',
    label: 'xAI',
    needsKey: true,
    keyHint: 'xai-…',
    models: suggest('xai', ['grok-3-mini']),
  },
  {
    id: 'ollama',
    label: 'Ollama (local, free)',
    needsKey: false,
    keyHint: 'no key needed',
    models: [],
  },
];

/**
 * Capacity for a chosen model. Ollama reports its own window at runtime, which
 * the caller supplies; everything else comes from the model registry in core,
 * and anything missing is reported as unknown rather than guessed.
 */
export function capacityFor(
  choice: ModelChoice,
  ollamaWindows?: Readonly<Record<string, number>>,
): { contextTokens: number | null; maxOutputTokens: number | null; source: 'vendor' | 'runtime' | 'user' | 'secondary' | 'unknown' } {
  const local = choice.provider === 'ollama' ? ollamaWindows?.[choice.model] : undefined;
  if (local !== undefined) return { contextTokens: local, maxOutputTokens: null, source: 'runtime' };
  const r = choice.provider === 'ollama' ? null : registered(choice);
  if (r?.contextTokens && r.provenance === 'vendor-docs') {
    return { contextTokens: r.contextTokens, maxOutputTokens: r.maxOutputTokens, source: 'vendor' };
  }
  // Measured or documented figures win; the user's number is the fallback.
  if (choice.contextWindow && choice.contextWindow > 0) {
    return { contextTokens: choice.contextWindow, maxOutputTokens: null, source: 'user' };
  }
  // An approximate published figure — the same one the Budget tab shows. The
  // budget's uncertainty margin still applies.
  if (r?.contextTokens) return { contextTokens: r.contextTokens, maxOutputTokens: r.maxOutputTokens, source: 'secondary' };
  return { contextTokens: null, maxOutputTokens: null, source: 'unknown' };
}

/** The registry entry for a choice, only if it belongs to the chosen provider. */
function registered(choice: ModelChoice): ReturnType<typeof lookupModel> {
  const r = lookupModel(choice.model);
  return r && r.provider === choice.provider ? r : null;
}

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;
}

/**
 * Rough cost for a planned run, from the registry's verified rates only;
 * anything without one returns null rather than a number invented for the
 * sake of showing one.
 */
export function estimateCostUsd(
  choice: ModelChoice,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (choice.provider === 'ollama') return 0;   // runs locally: no charge
  const r = registered(choice);
  if (r?.pricePerMTokIn === undefined || r.pricePerMTokOut === undefined) return null;
  return (inputTokens / 1e6) * r.pricePerMTokIn + (outputTokens / 1e6) * r.pricePerMTokOut;
}

/* ------------------------------------------------------------- providers */

async function completeAnthropic(a: CompleteArgs): Promise<Completion> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: a.apiKey, dangerouslyAllowBrowser: true });
  const res = await client.messages.create(
    {
      model: a.choice.model,
      max_tokens: a.maxTokens,
      system: a.system,
      messages: [{ role: 'user', content: a.user }],
    },
    a.signal ? { signal: a.signal } : {},
  );
  const text = res.content
    .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
}

/** OpenAI and xAI share a wire format; xAI only differs by base URL. */
async function completeOpenAiCompatible(a: CompleteArgs, base: string): Promise<Completion> {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.apiKey}` },
    body: JSON.stringify({
      model: a.choice.model,
      max_completion_tokens: a.maxTokens,
      messages: [
        { role: 'system', content: a.system },
        { role: 'user', content: a.user },
      ],
    }),
    ...(a.signal ? { signal: a.signal } : {}),
  });
  if (!res.ok) throw new Error(`${a.choice.provider} responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: body.choices?.[0]?.message?.content ?? '',
    ...(body.usage?.prompt_tokens !== undefined ? { inputTokens: body.usage.prompt_tokens } : {}),
    ...(body.usage?.completion_tokens !== undefined ? { outputTokens: body.usage.completion_tokens } : {}),
  };
}

async function completeGoogle(a: CompleteArgs): Promise<Completion> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(a.choice.model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': a.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: a.system }] },
      contents: [{ role: 'user', parts: [{ text: a.user }] }],
      generationConfig: { maxOutputTokens: a.maxTokens },
    }),
    ...(a.signal ? { signal: a.signal } : {}),
  });
  if (!res.ok) throw new Error(`Google responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  return {
    text,
    ...(body.usageMetadata?.promptTokenCount !== undefined
      ? { inputTokens: body.usageMetadata.promptTokenCount }
      : {}),
    ...(body.usageMetadata?.candidatesTokenCount !== undefined
      ? { outputTokens: body.usageMetadata.candidatesTokenCount }
      : {}),
  };
}

/**
 * Context to ask Ollama for. Without `num_ctx` Ollama uses its small default
 * and silently drops most of a long prompt (measured: 10,781 tokens of code
 * sent, 5,222 read). Sized to the request rather than the model's maximum,
 * so a short call does not reserve memory for 32k tokens.
 */
export function ollamaContext(system: string, user: string, maxTokens: number): number {
  const prompt = estimateFromText('p.md', system) + estimateFromText('p.md', user);
  return Math.ceil(((prompt + maxTokens) * 1.1) / 1024) * 1024;
}

async function completeOllama(a: CompleteArgs): Promise<Completion> {
  const numCtx = ollamaContext(a.system, a.user, a.maxTokens);
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: a.choice.model,
      stream: false,
      messages: [
        { role: 'system', content: a.system },
        { role: 'user', content: a.user },
      ],
      options: { num_predict: a.maxTokens, num_ctx: numCtx },
    }),
    ...(a.signal ? { signal: a.signal } : {}),
  });
  if (!res.ok) throw new Error(`Ollama responded ${res.status}. Is it running?`);
  const body = (await res.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  // No "too few tokens read" check: Ollama reuses its cache for a repeated prompt
  // prefix and counts only the new tokens, so a short count is not a cut prompt
  // (measured: a false alarm at 674 of ~1,687). Setting num_ctx is the fix.
  return {
    text: body.message?.content ?? '',
    ...(body.prompt_eval_count !== undefined ? { inputTokens: body.prompt_eval_count } : {}),
    ...(body.eval_count !== undefined ? { outputTokens: body.eval_count } : {}),
  };
}

export async function complete(a: CompleteArgs): Promise<Completion> {
  switch (a.choice.provider) {
    case 'anthropic': return completeAnthropic(a);
    case 'openai': return completeOpenAiCompatible(a, 'https://api.openai.com/v1');
    case 'xai': return completeOpenAiCompatible(a, 'https://api.x.ai/v1');
    case 'google': return completeGoogle(a);
    case 'ollama': return completeOllama(a);
  }
}
