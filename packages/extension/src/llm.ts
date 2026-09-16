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

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'xai' | 'ollama';

export interface ModelChoice {
  readonly provider: ProviderId;
  readonly model: string;
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

/** Known context/output limits per model. Absent means genuinely unknown. */
export const CAPACITY: Readonly<Record<string, { context: number; maxOutput: number }>> = {
  'claude-opus-5': { context: 200_000, maxOutput: 64_000 },
  'claude-sonnet-5': { context: 1_000_000, maxOutput: 64_000 },
  'claude-haiku-4-5': { context: 200_000, maxOutput: 64_000 },
};

export interface ProviderInfo {
  readonly id: ProviderId;
  readonly label: string;
  readonly needsKey: boolean;
  readonly keyHint: string;
  /** Suggested models. The user may type any model id instead. */
  readonly models: readonly string[];
  /** USD per million tokens, when published and verified. */
  readonly pricing?: Readonly<Record<string, { in: number; out: number }>>;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    needsKey: true,
    keyHint: 'sk-ant-…',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    // Verified against Anthropic's published rates.
    pricing: {
      'claude-opus-5': { in: 5, out: 25 },
      'claude-sonnet-5': { in: 2, out: 10 },
      'claude-haiku-4-5': { in: 1, out: 5 },
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    needsKey: true,
    keyHint: 'sk-…',
    models: ['gpt-5.1', 'gpt-5-mini', 'gpt-4.1-mini'],
  },
  {
    id: 'google',
    label: 'Google',
    needsKey: true,
    keyHint: 'AIza…',
    models: ['gemini-3-pro', 'gemini-2.5-flash'],
  },
  {
    id: 'xai',
    label: 'xAI',
    needsKey: true,
    keyHint: 'xai-…',
    models: ['grok-4', 'grok-3-mini'],
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
 * the caller supplies; everything else comes from the table, and anything
 * missing is reported as unknown rather than guessed.
 */
export function capacityFor(
  choice: ModelChoice,
  ollamaWindow?: number,
): { contextTokens: number | null; maxOutputTokens: number | null; source: 'vendor' | 'runtime' | 'unknown' } {
  if (choice.provider === 'ollama') {
    return ollamaWindow !== undefined
      ? { contextTokens: ollamaWindow, maxOutputTokens: null, source: 'runtime' }
      : { contextTokens: null, maxOutputTokens: null, source: 'unknown' };
  }
  const known = CAPACITY[choice.model];
  return known
    ? { contextTokens: known.context, maxOutputTokens: known.maxOutput, source: 'vendor' }
    : { contextTokens: null, maxOutputTokens: null, source: 'unknown' };
}

export function providerInfo(id: ProviderId): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;
}

/**
 * Rough cost for a planned run. Only Anthropic rates are published here and
 * verified; anything else returns null rather than a number invented for the
 * sake of showing one.
 */
export function estimateCostUsd(
  choice: ModelChoice,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = providerInfo(choice.provider).pricing?.[choice.model];
  if (!price) return null;
  return (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
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

async function completeOllama(a: CompleteArgs): Promise<Completion> {
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
      options: { num_predict: a.maxTokens },
    }),
    ...(a.signal ? { signal: a.signal } : {}),
  });
  if (!res.ok) throw new Error(`Ollama responded ${res.status}. Is it running?`);
  const body = (await res.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
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
