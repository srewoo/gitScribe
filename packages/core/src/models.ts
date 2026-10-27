import { MODEL_REGISTRY } from './registry.js';

/**
 * Context windows for fit checks — a view of `registry.ts`, the one table of
 * models. Every entry carries the source of its number; anything not verified
 * against vendor documentation is marked so the UI can say "approximate".
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

const VENDOR = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI', ollama: 'Ollama' } as const;

/** Models with a known window. Unknown ones are left out rather than guessed. */
export const MODELS: readonly ModelEntry[] = MODEL_REGISTRY.flatMap((r) =>
  r.contextTokens === null ? [] : [{
    id: r.id, name: r.name, vendor: VENDOR[r.provider], contextWindow: r.contextTokens,
    windowSource: r.provenance === 'vendor-docs' ? 'vendor' : r.provenance === 'runtime' ? 'runtime' : 'secondary',
    verifiedOn: r.verifiedOn,
  }]);

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
