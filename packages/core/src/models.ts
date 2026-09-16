/**
 * Context-window registry.
 *
 * Every entry carries the source of its number. Anything not verified against
 * vendor documentation ships marked as an estimate, and the UI must say so —
 * quoting a wrong window is worse than admitting we do not know it.
 */
export type WindowSource = 'vendor' | 'secondary' | 'runtime';

export interface ModelEntry {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly contextWindow: number;
  readonly windowSource: WindowSource;
  readonly verifiedOn: string;
}

export const MODELS: readonly ModelEntry[] = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', vendor: 'Anthropic', contextWindow: 200_000, windowSource: 'vendor', verifiedOn: '2026-09-16' },
  { id: 'claude-opus-5[1m]', name: 'Claude Opus 5 (1M)', vendor: 'Anthropic', contextWindow: 1_000_000, windowSource: 'vendor', verifiedOn: '2026-09-16' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', vendor: 'Anthropic', contextWindow: 1_000_000, windowSource: 'vendor', verifiedOn: '2026-09-16' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', vendor: 'Anthropic', contextWindow: 200_000, windowSource: 'vendor', verifiedOn: '2026-09-16' },
  { id: 'gpt-5.1', name: 'GPT-5.1', vendor: 'OpenAI', contextWindow: 400_000, windowSource: 'secondary', verifiedOn: '2026-09-16' },
  { id: 'gemini-3-pro', name: 'Gemini 3 Pro', vendor: 'Google', contextWindow: 1_048_576, windowSource: 'secondary', verifiedOn: '2026-09-16' },
  { id: 'grok-4', name: 'Grok 4', vendor: 'xAI', contextWindow: 256_000, windowSource: 'secondary', verifiedOn: '2026-09-16' },
];

/** Held back for the user's prompt and the model's reply. */
export const DEFAULT_RESERVE = 8_000;

export function usableWindow(m: ModelEntry, reserve = DEFAULT_RESERVE): number {
  return Math.max(0, m.contextWindow - reserve);
}

export interface OllamaModel {
  readonly name: string;
  readonly contextWindow: number;
}

/**
 * Discover locally-running Ollama models. This is the one family whose window
 * is exact rather than estimated, because it is read from the running server.
 * Returns [] when Ollama is not running — not an error, just absence.
 */
export async function discoverOllama(
  fetchFn: typeof globalThis.fetch,
  base = 'http://127.0.0.1:11434',
): Promise<readonly OllamaModel[]> {
  try {
    const res = await fetchFn(`${base}/api/tags`);
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const names = (body.models ?? []).map((m) => m.name).filter((n): n is string => !!n);

    const out: OllamaModel[] = [];
    for (const name of names) {
      const show = await fetchFn(`${base}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
      });
      if (!show.ok) continue;
      const info = (await show.json()) as { model_info?: Record<string, unknown> };
      const ctx = Object.entries(info.model_info ?? {}).find(([k]) => k.endsWith('.context_length'));
      out.push({ name, contextWindow: typeof ctx?.[1] === 'number' ? ctx[1] : 8192 });
    }
    return out;
  } catch {
    return [];
  }
}
