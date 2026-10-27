import { type ForgeId } from './tokens.js';
import { decide, MODELS, type Format, type ModelEntry, type RepoTree, type Selection, type TreeFile } from '@gitscribe/core';
import { type ModelChoice } from './llm.js';

/* ------------------------------------------------------------------ state */

export interface State {
  forge: ForgeId;
  project: string;
  ref: string;
  /** The immutable commit everything in this session is pinned to. */
  commit: string;
  digestId: string | null;
  jobId: string | null;
  tree: RepoTree | null;
  rules: Array<{ glob: string; on: boolean; mode: 'exclude' | 'include' }>;
  ruleMode: 'exclude' | 'include';
  overrides: Record<string, boolean>;
  collapsed: Record<string, boolean>;
  filter: string;
  modelId: string;
  ollama: Array<{ name: string; contextWindow: number }>;
  digestText: string;
  format: Format;
  part: number;
  parts: number;
  mapChoice: ModelChoice;
  reduceChoice: ModelChoice;
  readmeText: string;
  diffText: string;
}

export const S: State = {
  forge: 'github', project: '', ref: '', commit: '', digestId: null, jobId: null, tree: null,
  rules: [], ruleMode: 'exclude', overrides: {}, collapsed: {}, filter: '',
  modelId: MODELS[0]!.id, ollama: [], digestText: '', format: 'md', part: 1, parts: 1,
  mapChoice: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  reduceChoice: { provider: 'anthropic', model: 'claude-opus-5' },
  readmeText: '', diffText: '',
};

export const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`GitScribe: no element with id "${id}" in sidepanel.html`);
  return el as T;
};
export const fmt = (n: number): string => n.toLocaleString('en-US');
export const kfmt = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);
/** GitLab's tree API carries no sizes: show "?" rather than a zero that reads as "free". */
export const sizesUnknown = (): boolean => S.tree?.sizesUnknown === true;
export const tokfmt = (n: number): string => (sizesUnknown() ? '?' : kfmt(n));

export function send<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: { ok: boolean; data?: T; error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error ?? 'Unknown error'));
      resolve(res.data as T);
    });
  });
}

export function selection(): Selection {
  return {
    exclude: S.rules.filter((r) => r.on && r.mode === 'exclude').map((r) => r.glob),
    include: S.rules.filter((r) => r.on && r.mode === 'include').map((r) => r.glob),
    overrides: S.overrides,
  };
}

export function currentModel(): ModelEntry {
  const local = S.ollama.find((m) => m.name === S.modelId);
  if (local) {
    return {
      id: local.name, name: local.name, vendor: 'Ollama',
      contextWindow: local.contextWindow, windowSource: 'runtime', verifiedOn: 'now',
    };
  }
  return MODELS.find((m) => m.id === S.modelId) ?? MODELS[0]!;
}

export function selectedFiles(): TreeFile[] {
  if (!S.tree) return [];
  return S.tree.files.filter((f) => decide(f.path, selection()).selected);
}

/** Each discovered Ollama model's own window, so two local models never share one. */
export const ollamaWindows = (): Record<string, number> =>
  Object.fromEntries(S.ollama.map((m) => [m.name, m.contextWindow]));
