/**
 * Model and provider registry (IMP-14).
 *
 * Context windows, pricing, provider endpoints and suggested models were
 * spread across three files with no record of where any number came from. A
 * stale window produces a wrong fit claim; a stale price produces a wrong cost
 * estimate. Both are worse than saying "unknown".
 *
 * Every entry therefore carries its source and the date it was checked. The
 * freshness script fails when an entry ages out, so the fix is to re-verify
 * rather than to quietly keep serving it.
 */

export type ProviderId = 'anthropic' | 'openai' | 'google' | 'xai' | 'ollama';
export type Provenance = 'vendor-docs' | 'secondary' | 'runtime' | 'unverified';

export interface ModelEntry {
  readonly id: string;
  readonly provider: ProviderId;
  readonly name: string;
  /** Total context window. Null when we do not actually know it. */
  readonly contextTokens: number | null;
  /** Largest output the model will emit, when documented. */
  readonly maxOutputTokens: number | null;
  /** USD per million tokens. Absent means we will report cost as unknown. */
  readonly pricePerMTokIn?: number;
  readonly pricePerMTokOut?: number;
  readonly provenance: Provenance;
  /** Where the numbers came from. Empty for runtime-discovered models. */
  readonly sourceUrl?: string;
  /** ISO date the entry was last checked against that source. */
  readonly verifiedOn: string;
  /** Endpoint family, so a caller does not assume one wire format. */
  readonly endpoint: 'anthropic-messages' | 'openai-chat' | 'google-generate' | 'ollama-chat';
}

const CHECKED = '2026-09-16';

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  {
    id: 'claude-opus-5', provider: 'anthropic', name: 'Claude Opus 5',
    contextTokens: 200_000, maxOutputTokens: 64_000,
    pricePerMTokIn: 5, pricePerMTokOut: 25,
    provenance: 'vendor-docs', sourceUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
    verifiedOn: CHECKED, endpoint: 'anthropic-messages',
  },
  {
    id: 'claude-sonnet-5', provider: 'anthropic', name: 'Claude Sonnet 5',
    contextTokens: 1_000_000, maxOutputTokens: 64_000,
    pricePerMTokIn: 2, pricePerMTokOut: 10,
    provenance: 'vendor-docs', sourceUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
    verifiedOn: CHECKED, endpoint: 'anthropic-messages',
  },
  {
    id: 'claude-haiku-4-5', provider: 'anthropic', name: 'Claude Haiku 4.5',
    contextTokens: 200_000, maxOutputTokens: 64_000,
    pricePerMTokIn: 1, pricePerMTokOut: 5,
    provenance: 'vendor-docs', sourceUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
    verifiedOn: CHECKED, endpoint: 'anthropic-messages',
  },
  // Deliberately null: these were only ever sourced from secondary write-ups,
  // so claiming a window would be inventing one. The UI must say unknown.
  {
    id: 'gpt-5.1', provider: 'openai', name: 'GPT-5.1',
    contextTokens: null, maxOutputTokens: null,
    provenance: 'unverified', verifiedOn: CHECKED, endpoint: 'openai-chat',
  },
  {
    id: 'gemini-3-pro', provider: 'google', name: 'Gemini 3 Pro',
    contextTokens: null, maxOutputTokens: null,
    provenance: 'unverified', verifiedOn: CHECKED, endpoint: 'google-generate',
  },
  {
    id: 'grok-4', provider: 'xai', name: 'Grok 4',
    contextTokens: null, maxOutputTokens: null,
    provenance: 'unverified', verifiedOn: CHECKED, endpoint: 'openai-chat',
  },
];

export function lookupModel(id: string): ModelEntry | null {
  return MODEL_REGISTRY.find((m) => m.id === id) ?? null;
}

export function modelsFor(provider: ProviderId): readonly ModelEntry[] {
  return MODEL_REGISTRY.filter((m) => m.provider === provider);
}

/**
 * A model the user typed in, or one Ollama reported. Runtime-discovered
 * windows are exact; a hand-typed model is unverified until proven otherwise.
 */
export function customModel(
  id: string,
  provider: ProviderId,
  contextTokens: number | null,
  provenance: Provenance = 'unverified',
): ModelEntry {
  return {
    id, provider, name: id,
    contextTokens, maxOutputTokens: null,
    provenance,
    verifiedOn: new Date().toISOString().slice(0, 10),
    endpoint:
      provider === 'anthropic' ? 'anthropic-messages'
      : provider === 'google' ? 'google-generate'
      : provider === 'ollama' ? 'ollama-chat'
      : 'openai-chat',
  };
}

export interface FreshnessIssue {
  readonly id: string;
  readonly ageDays: number;
  readonly reason: string;
}

/** Entries that have aged out, or that never had a verifiable source. */
export function staleEntries(maxAgeDays: number, now = Date.now()): FreshnessIssue[] {
  const out: FreshnessIssue[] = [];
  for (const m of MODEL_REGISTRY) {
    const age = Math.floor((now - Date.parse(m.verifiedOn)) / 86_400_000);
    if (age > maxAgeDays) {
      out.push({ id: m.id, ageDays: age, reason: `last checked ${age} days ago` });
    } else if (m.provenance === 'unverified' && m.contextTokens !== null) {
      // An unverified entry must not carry a confident number.
      out.push({ id: m.id, ageDays: age, reason: 'unverified provenance but states a context window' });
    }
  }
  return out;
}
