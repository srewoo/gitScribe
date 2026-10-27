import { type ForgeId } from './tokens.js';
import { renderTotals } from './panel-budget.js';
import { load, showPane } from './panel-load.js';
import { $, S, State, kfmt } from './panel-state.js';
import { renderRules, renderTree } from './panel-tree.js';

/* ------------------------------------------------------ presets & history */

export interface Preset {
  name: string;
  rules: State['rules'];
  overrides: Record<string, boolean>;
}
export interface HistoryEntry {
  project: string; forge: ForgeId; ref: string; commit?: string;
  files: number; tokens: number; at: number;
}

export const presetKey = (): string => `presets:${S.forge}:${S.project}`;

export async function loadPresets(): Promise<Preset[]> {
  const got = await chrome.storage.local.get(presetKey());
  return (got[presetKey()] as Preset[] | undefined) ?? [];
}

export async function recordHistory(files: number, tokens: number): Promise<void> {
  const got = await chrome.storage.local.get('history');
  const list = ((got['history'] as HistoryEntry[] | undefined) ?? []).filter(
    (h) => !(h.project === S.project && h.ref === S.ref),
  );
  list.unshift({
    project: S.project, forge: S.forge, ref: S.ref, commit: S.commit,
    files, tokens, at: Date.now(),
  });
  await chrome.storage.local.set({ history: list.slice(0, 20) });
}

export function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

export async function renderPresets(): Promise<void> {
  const host = $('presetList');
  host.textContent = '';
  const presets = await loadPresets();
  if (presets.length === 0) {
    const e = document.createElement('div');
    e.style.cssText = 'font-size:11px;color:var(--tx3)';
    e.textContent = S.project
      ? 'No presets saved for this repository yet.'
      : 'Open a repository to save presets for it.';
    host.append(e);
  }
  for (const p of presets) {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid var(--line)';
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;min-width:0';
    const n = document.createElement('span');
    n.style.cssText = 'display:block;font-size:12px;font-weight:500';
    n.textContent = p.name;
    const g = document.createElement('span');
    g.className = 'm';
    g.style.cssText =
      'display:block;font-size:10px;color:var(--tx3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    g.textContent = p.rules.filter((r) => r.on).map((r) => (r.mode === 'include' ? `only ${r.glob}` : r.glob)).join(', ');
    label.append(n, g);

    const apply = document.createElement('button');
    apply.className = 'btn';
    apply.style.height = '24px';
    apply.textContent = 'Apply';
    apply.addEventListener('click', () => {
      S.rules = p.rules.map((r) => ({ ...r }));
      S.overrides = { ...p.overrides };
      renderRules(); renderTree(); renderTotals();
      showPane('files');
    });

    const del = document.createElement('button');
    del.className = 'btn';
    del.style.height = '24px';
    del.textContent = '\u00d7';
    del.addEventListener('click', () => {
      void loadPresets().then((all) =>
        chrome.storage.local.set({ [presetKey()]: all.filter((x) => x.name !== p.name) }),
      ).then(renderPresets);
    });

    row.append(label, apply, del);
    host.append(row);
  }
}

export async function renderHistory(): Promise<void> {
  const host = $('historyList');
  host.textContent = '';
  const got = await chrome.storage.local.get('history');
  const list = (got['history'] as HistoryEntry[] | undefined) ?? [];
  if (list.length === 0) {
    const e = document.createElement('div');
    e.style.cssText = 'font-size:11px;color:var(--tx3)';
    e.textContent = 'No digests yet.';
    host.append(e);
    return;
  }
  for (const h of list) {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid var(--line);cursor:pointer';
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;min-width:0';
    const n = document.createElement('span');
    n.className = 'm';
    n.style.cssText =
      'display:block;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    n.textContent = h.project;
    const sub = document.createElement('span');
    sub.style.cssText = 'display:block;font-size:10px;color:var(--tx3);margin-top:2px';
    sub.textContent = `${ago(h.at)} \u00b7 ${h.files} files \u00b7 ${h.forge}`;
    label.append(n, sub);
    const tok = document.createElement('span');
    tok.className = 'm';
    tok.style.cssText = 'font-size:11px;color:var(--tx2)';
    tok.textContent = kfmt(h.tokens);
    row.append(label, tok);
    row.addEventListener('click', () => {
      // Reopen at the exact commit that was digested, not wherever the branch
      // has since moved to.
      void load({ forge: h.forge, project: h.project, ref: h.commit ?? h.ref });
    });
    host.append(row);
  }
}
