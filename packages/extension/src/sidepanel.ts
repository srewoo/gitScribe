/**
 * Side panel UI. Owns no network access — every fetch goes through the
 * background worker, which is the only CORS-exempt context.
 */
import {
  decide,
  suggestDrops,
  MODELS,
  DEFAULT_RESERVE,
  usableWindow,
  type Format,
  type ModelEntry,
  type RepoTree,
  type Selection,
  type TreeFile,
} from '@gitscribe/core';
import { visibleRange } from './vwindow.js';
import { EXACT_SUPPORT, providerOf } from './counters.js';
import { loadTokens, saveToken, saveGitlabHost, requestProviderAccess, hasProviderAccess, requestGitlabHost, type ForgeId, type TokenCheck } from './tokens.js';
import { PROVIDERS, providerInfo, type ModelChoice, type ProviderId } from './llm.js';

/* ------------------------------------------------------------------ state */

interface State {
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

const S: State = {
  forge: 'github', project: '', ref: '', commit: '', digestId: null, jobId: null, tree: null,
  rules: [], ruleMode: 'exclude', overrides: {}, collapsed: {}, filter: '',
  modelId: MODELS[0]!.id, ollama: [], digestText: '', format: 'md', part: 1, parts: 1,
  mapChoice: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  reduceChoice: { provider: 'anthropic', model: 'claude-opus-5' },
  readmeText: '', diffText: '',
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`GitScribe: no element with id "${id}" in sidepanel.html`);
  return el as T;
};
const fmt = (n: number): string => n.toLocaleString('en-US');
const kfmt = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);

function send<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: { ok: boolean; data?: T; error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!res?.ok) return reject(new Error(res?.error ?? 'Unknown error'));
      resolve(res.data as T);
    });
  });
}

function selection(): Selection {
  return {
    exclude: S.rules.filter((r) => r.on && r.mode === 'exclude').map((r) => r.glob),
    include: S.rules.filter((r) => r.on && r.mode === 'include').map((r) => r.glob),
    overrides: S.overrides,
  };
}

function currentModel(): ModelEntry {
  const local = S.ollama.find((m) => m.name === S.modelId);
  if (local) {
    return {
      id: local.name, name: local.name, vendor: 'Ollama',
      contextWindow: local.contextWindow, windowSource: 'runtime', verifiedOn: 'now',
    };
  }
  return MODELS.find((m) => m.id === S.modelId) ?? MODELS[0]!;
}

function selectedFiles(): TreeFile[] {
  if (!S.tree) return [];
  return S.tree.files.filter((f) => decide(f.path, selection()).selected);
}

/* -------------------------------------------------------------------- tree */

interface Node {
  name: string; path: string; dir: boolean;
  kids: Map<string, Node>; file?: TreeFile;
  sel: number; total: number; tokens: number;
}

function buildTree(files: readonly TreeFile[]): Node {
  const root: Node = { name: '', path: '', dir: true, kids: new Map(), sel: 0, total: 0, tokens: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const nm = parts[i]!;
      let next = cur.kids.get(nm);
      if (!next) {
        next = { name: nm, path: parts.slice(0, i + 1).join('/'), dir: true, kids: new Map(), sel: 0, total: 0, tokens: 0 };
        cur.kids.set(nm, next);
      }
      cur = next;
    }
    const leaf = parts[parts.length - 1]!;
    cur.kids.set(leaf, { name: leaf, path: f.path, dir: false, kids: new Map(), file: f, sel: 0, total: 0, tokens: 0 });
  }
  return root;
}

/** Squash single-child directory chains so depth means branching. */
function squash(n: Node): void {
  for (const child of n.kids.values()) {
    if (!child.dir) continue;
    while (child.kids.size === 1) {
      const only = [...child.kids.values()][0]!;
      if (!only.dir) break;
      child.name = `${child.name}/${only.name}`;
      child.path = only.path;
      child.kids = only.kids;
    }
    squash(child);
  }
}

function tally(n: Node, sel: Selection): void {
  if (!n.dir) {
    const d = decide(n.file!.path, sel);
    n.total = 1;
    n.sel = d.selected ? 1 : 0;
    n.tokens = d.selected ? n.file!.tokens : 0;
    return;
  }
  n.sel = 0; n.total = 0; n.tokens = 0;
  for (const c of n.kids.values()) {
    tally(c, sel);
    n.sel += c.sel; n.total += c.total; n.tokens += c.tokens;
  }
}

/**
 * Row height is fixed in CSS so the window maths is a multiply rather than a
 * measure. Changing .row's height in sidepanel.css means changing this.
 */
const ROW_H = 24;
const OVERSCAN = 8;

interface Row {
  index: number;
  key: string;
  name: string;
  dir: boolean;
  depth: number;
  path: string;
  tokens: string;
  excluded: string | null;
  cb: 'on' | 'mix' | '';
  count: string;
  file?: TreeFile;
}

/** Flattened visible rows. Rebuilt on state change, not on scroll. */
let rows: Row[] = [];
let paintScheduled = false;
/** Index of the row that owns the tab stop. */
let focusedRow = 0;
/**
 * Whether focus currently lives inside the tree. A scroll repaints the window
 * and destroys the focused node, so focus has to be re-applied afterwards —
 * otherwise jumping to a row that was virtualized out silently loses it.
 */
let treeFocused = false;

/** Move focus within the tree, scrolling the row into view if virtualized out. */
function focusRowAt(index: number): void {
  if (rows.length === 0) return;
  focusedRow = Math.max(0, Math.min(rows.length - 1, index));
  const host = $('tree');
  const top = focusedRow * ROW_H;
  if (top < host.scrollTop) host.scrollTop = top;
  else if (top + ROW_H > host.scrollTop + host.clientHeight) {
    host.scrollTop = top - host.clientHeight + ROW_H;
  }
  treeFocused = true;
  paint();
  const el = document.querySelector<HTMLElement>(`[data-row="${focusedRow}"]`);
  el?.focus({ preventScroll: true });
  // Announce the move for screen readers that do not follow DOM focus alone.
  const r = rows[focusedRow];
  if (r) {
    $('treeStatus').textContent =
      `${r.name}, ${r.dir ? 'folder' : 'file'}, row ${focusedRow + 1} of ${rows.length}`;
  }
}

function flatten(root: Node, sel: Selection): Row[] {
  const out: Row[] = [];
  const walk = (n: Node, depth: number): void => {
    const kids = [...n.kids.values()].sort((a, b) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name));

    for (const c of kids) {
      if (c.dir) {
        const all = c.sel === c.total && c.total > 0;
        out.push({
          index: out.length,
          key: `d:${c.path}`, name: c.name, dir: true, depth, path: c.path,
          tokens: kfmt(c.tokens), excluded: null,
          cb: all ? 'on' : c.sel > 0 ? 'mix' : '',
          count: `${c.sel}/${c.total}`,
        });
        if (!S.collapsed[c.path]) walk(c, depth + 1);
      } else {
        const d = decide(c.file!.path, sel);
        out.push({
          index: out.length,
          key: `f:${c.file!.path}`, name: c.name, dir: false, depth, path: c.file!.path,
          tokens: kfmt(c.file!.tokens), excluded: d.excludedBy,
          cb: d.selected ? 'on' : '', count: '', file: c.file!,
        });
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Rebuild the row model, then paint the visible window.
 *
 * ponytail: the model rebuild is O(files) on every toggle — fine to ~30k
 * files. If a monorepo makes toggling feel sticky, make tally() incremental
 * (walk only the ancestors of the changed path) rather than rebuilding.
 */
function renderTree(): void {
  const host = $('tree');
  if (!S.tree) { host.textContent = ''; rows = []; return; }

  const f = S.filter.toLowerCase();
  const visible = f ? S.tree.files.filter((x) => x.path.toLowerCase().includes(f)) : S.tree.files;
  const root = buildTree(visible);
  squash(root);
  const sel = selection();
  tally(root, sel);
  rows = flatten(root, sel);

  let spacer = document.getElementById('vspace');
  if (!spacer) {
    host.textContent = '';
    spacer = document.createElement('div');
    spacer.id = 'vspace';
    // A virtualized list still has to describe itself: without a set size a
    // screen reader announces only the handful of rows currently painted.
    spacer.setAttribute('role', 'tree');
    spacer.setAttribute('aria-label', 'Repository files');
    host.append(spacer);
  }
  spacer.setAttribute('aria-setsize', String(rows.length));
  spacer.style.height = `${rows.length * ROW_H}px`;
  paint();
}

function buildRowEl(r: Row): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row' + (r.dir ? ' dir' : '') + (r.excluded ? ' ex' : '');
  // Roving tabindex: one stop for the whole tree, arrows move within it.
  row.tabIndex = r.index === focusedRow ? 0 : -1;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(r.depth + 1));
  row.setAttribute('aria-posinset', String(r.index + 1));
  row.setAttribute('aria-setsize', String(rows.length));
  row.setAttribute(
    'aria-label',
    `${r.name}, ${r.dir ? 'folder' : 'file'}, ${r.tokens} tokens` +
      (r.excluded ? `, excluded by ${r.excluded}` : ''),
  );
  if (r.dir) {
    row.setAttribute('aria-expanded', String(!S.collapsed[r.path]));
  } else {
    // Mixed state is meaningful on folders; files are simply checked or not.
    row.setAttribute('aria-checked', r.cb === 'on' ? 'true' : 'false');
  }
  if (r.dir && r.cb === 'mix') row.setAttribute('aria-checked', 'mixed');
  row.style.paddingLeft = `${10 + r.depth * 13}px`;

  const tw = document.createElement('span');
  tw.className = 'tw';
  tw.textContent = r.dir ? (S.collapsed[r.path] ? '\u25B8' : '\u25BE') : '';
  row.append(tw);

  const cb = document.createElement('span');
  cb.className = 'cb' + (r.cb ? ` ${r.cb}` : '');
  row.append(cb);

  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = r.name;
  row.append(nm);

  if (r.excluded) {
    const rule = document.createElement('span');
    rule.className = 'rule';
    rule.textContent = r.excluded;
    row.append(rule);
  } else if (r.dir) {
    const cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = r.count;
    row.append(cnt);
  }

  const tok = document.createElement('span');
  tok.className = 'tok';
  tok.textContent = r.tokens;
  row.append(tok);

  const activate = (): void => {
    if (r.dir) {
      S.collapsed[r.path] = !S.collapsed[r.path];
      renderTree();
    } else {
      S.overrides[r.path] = r.cb !== 'on';
      renderTree();
      renderTotals();
    }
  };
  row.addEventListener('click', activate);
  row.addEventListener('focus', () => { focusedRow = r.index; treeFocused = true; });
  row.addEventListener('blur', () => {
    // Only give up the claim if focus left the tree entirely.
    setTimeout(() => {
      const active = document.activeElement;
      treeFocused = active instanceof HTMLElement && active.dataset['row'] !== undefined;
    }, 0);
  });
  row.addEventListener('keydown', (e) => {
    switch (e.key) {
      case ' ':
      case 'Enter':
        e.preventDefault();
        activate();
        return;
      case 'ArrowDown': e.preventDefault(); focusRowAt(r.index + 1); return;
      case 'ArrowUp': e.preventDefault(); focusRowAt(r.index - 1); return;
      case 'Home': e.preventDefault(); focusRowAt(0); return;
      case 'End': e.preventDefault(); focusRowAt(rows.length - 1); return;
      case 'PageDown': e.preventDefault(); focusRowAt(r.index + 10); return;
      case 'PageUp': e.preventDefault(); focusRowAt(r.index - 10); return;
      case 'ArrowRight':
        if (r.dir && S.collapsed[r.path]) {
          e.preventDefault();
          S.collapsed[r.path] = false;
          renderTree();
          focusRowAt(r.index);
        }
        return;
      case 'ArrowLeft':
        if (r.dir && !S.collapsed[r.path]) {
          e.preventDefault();
          S.collapsed[r.path] = true;
          renderTree();
          focusRowAt(r.index);
        }
        return;
      default:
        return;
    }
  });
  return row;
}

/**
 * Paint only the rows in view plus a small overscan. Reuses the pooled
 * elements when the window has not moved, so scrolling a 26,000-file tree
 * touches a few dozen nodes rather than 26,000.
 */
function paint(): void {
  const host = $('tree');
  const spacer = document.getElementById('vspace');
  if (!spacer) return;

  const { first, last } = visibleRange(
    host.scrollTop, host.clientHeight, rows.length, ROW_H, OVERSCAN,
  );

  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const r = rows[i];
    if (!r) continue;
    const el = buildRowEl(r);
    el.dataset['row'] = String(i);
    el.style.transform = `translateY(${i * ROW_H}px)`;
    frag.append(el);
  }
  spacer.textContent = '';
  spacer.append(frag);

  // Re-apply focus after a repaint, but only if the user was already in the
  // tree — never steal focus from the filter box or a button.
  if (treeFocused) {
    const el = spacer.querySelector<HTMLElement>(`[data-row="${focusedRow}"]`);
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
  }
}

function onScroll(): void {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(() => { paintScheduled = false; paint(); });
}

function renderRules(): void {
  const host = $('rules');
  host.textContent = '';
  for (const r of S.rules) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (r.on ? ' on' : '');
    chip.tabIndex = 0;
    if (r.mode === 'include') {
      const lead = document.createElement('span');
      lead.style.color = 'var(--ok)';
      lead.textContent = 'only ';
      chip.append(lead);
    }
    chip.append(document.createTextNode(r.glob));

    const x = document.createElement('span');
    x.textContent = '\u00d7';
    x.style.cssText = 'margin-left:5px;color:var(--tx3)';
    x.title = 'Remove rule';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      S.rules = S.rules.filter((y) => y !== r);
      renderRules(); renderTree(); renderTotals();
    });
    chip.append(x);

    chip.addEventListener('click', () => {
      r.on = !r.on;
      renderRules(); renderTree(); renderTotals(); invalidatePlan();
    });
    host.append(chip);
  }

  const add = document.createElement('span');
  add.className = 'chip add';
  add.textContent = '+ rule';
  add.tabIndex = 0;
  add.addEventListener('click', () => {
    $('ruleAdd').classList.toggle('hide');
    if (!$('ruleAdd').classList.contains('hide')) $('ruleInput').focus();
  });
  host.append(add);
}

function addRuleFromInput(): void {
  const input = $('ruleInput') as HTMLInputElement;
  const glob = input.value.trim();
  if (!glob) return;
  if (!S.rules.some((r) => r.glob === glob && r.mode === S.ruleMode)) {
    S.rules.push({ glob, on: true, mode: S.ruleMode });
  }
  input.value = '';
  $('ruleAdd').classList.add('hide');
  renderRules(); renderTree(); renderTotals();
}

/* ------------------------------------------------------ presets & history */

interface Preset {
  name: string;
  rules: State['rules'];
  overrides: Record<string, boolean>;
}
interface HistoryEntry {
  project: string; forge: ForgeId; ref: string; commit?: string;
  files: number; tokens: number; at: number;
}

const presetKey = (): string => `presets:${S.forge}:${S.project}`;

async function loadPresets(): Promise<Preset[]> {
  const got = await chrome.storage.local.get(presetKey());
  return (got[presetKey()] as Preset[] | undefined) ?? [];
}

async function recordHistory(files: number, tokens: number): Promise<void> {
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

function ago(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

async function renderPresets(): Promise<void> {
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

async function renderHistory(): Promise<void> {
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

/** A reviewed plan is only valid for what was reviewed. */
function invalidatePlan(): void {
  if (prepared !== null) {
    hidePlan();
    setReadmeStatus('The selection or model changed — prepare the plan again.', 'w');
  }
}

function renderTotals(): void {
  const files = selectedFiles();
  const total = files.reduce((n, f) => n + f.tokens, 0);
  const m = currentModel();
  const usable = usableWindow(m, DEFAULT_RESERVE);
  const ratio = usable > 0 ? total / usable : 0;

  $('total').textContent = fmt(total);
  $('selCount').textContent = `${fmt(files.length)} of ${fmt(S.tree?.files.length ?? 0)} files · ${m.name}`;
  $('pct').textContent = `${Math.round(ratio * 100)}% of window`;
  $('pct').style.color = ratio > 1 ? 'var(--dg)' : ratio > 0.85 ? 'var(--warn)' : 'var(--tx2)';
  $('meter').className = 'meter' + (ratio > 1 ? ' d' : ratio > 0.85 ? ' w' : '');
  $('bar').style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`;

  renderBudget(total, usable, m, files);
}

function renderBudget(total: number, usable: number, m: ModelEntry, files: TreeFile[]): void {
  const host = $('models');
  host.textContent = '';
  const entries: Array<{ id: string; name: string; vendor: string; window: number; note: string }> = [
    ...MODELS.map((x) => ({
      id: x.id, name: x.name, vendor: x.vendor, window: x.contextWindow,
      note: x.windowSource === 'vendor' ? '' : 'approximate',
    })),
    ...S.ollama.map((x) => ({
      id: x.name, name: x.name, vendor: 'Ollama · local', window: x.contextWindow, note: 'exact',
    })),
  ];

  for (const e of entries) {
    const u = e.window - DEFAULT_RESERVE;
    const fits = total <= u;
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:9px;padding:7px 0;border-bottom:1px solid var(--line);cursor:pointer';
    row.innerHTML =
      `<span style="width:3px;height:16px;border-radius:2px;flex:none;background:${
        e.id === S.modelId ? 'var(--ac)' : 'transparent'
      }"></span>` +
      `<span style="flex:1;min-width:0">` +
      `<span style="display:block;font-size:12px;font-weight:${e.id === S.modelId ? 600 : 400}"></span>` +
      `<span style="display:block;font-size:10px;color:var(--tx3);margin-top:1px"></span></span>` +
      `<span class="m" style="font-size:11px;color:var(--tx2)">${kfmt(e.window)}</span>` +
      `<span style="font-size:10px;width:42px;text-align:right;color:${
        fits ? 'var(--ok)' : 'var(--dg)'
      }">${fits ? 'fits' : `+${kfmt(total - u)}`}</span>`;
    // textContent for model-supplied strings, so a repo can never inject markup
    const spans = row.querySelectorAll('span > span');
    (spans[0] as HTMLElement).textContent = e.name;
    (spans[1] as HTMLElement).textContent = e.note ? `${e.vendor} · ${e.note}` : e.vendor;
    row.addEventListener('click', () => { S.modelId = e.id; renderTotals(); updateExactHint(); });
    host.append(row);
  }

  const over = total - usable;
  const note = $('advice');
  note.className = 'note ' + (over > 0 ? 'd' : 'o');
  note.textContent =
    over > 0
      ? `Over by ${fmt(over)} tokens. Counts are estimates, deliberately biased to over-count — there is no public tokenizer for ${m.vendor}.`
      : `Fits with ${fmt(-over)} to spare. Counts are estimates.`;

  const drops = $('drops');
  drops.textContent = '';
  if (over > 0) {
    const list = suggestDrops(files, over);
    const head = document.createElement('div');
    head.className = 'eyebrow';
    head.style.margin = '13px 0 7px';
    head.textContent = 'Largest first';
    drops.append(head);
    for (const d of list) {
      const r = document.createElement('div');
      r.style.cssText = 'display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--line)';
      const p = document.createElement('span');
      p.className = 'm';
      p.style.cssText = 'flex:1;min-width:0;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      p.textContent = d.path;
      const t = document.createElement('span');
      t.className = 'm';
      t.style.cssText = 'font-size:10.5px;color:var(--tx2)';
      t.textContent = kfmt(d.tokens);
      r.append(p, t);
      drops.append(r);
    }
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.cssText = 'width:100%;margin-top:10px';
    btn.textContent = `Uncheck these ${list.length} files`;
    btn.addEventListener('click', () => {
      for (const d of list) S.overrides[d.path] = false;
      renderTree(); renderTotals();
    });
    drops.append(btn);
  }
}

/* ------------------------------------------------------------------ panes */

function showPane(name: string): void {
  for (const [id, tab] of [
    ['filesPane', 'files'], ['budgetPane', 'budget'],
    ['outputPane', 'output'], ['settingsPane', 'settings'], ['presetsPane', 'presets'],
    ['readmePane', 'readme'], ['changesPane', 'changes'],
  ] as const) {
    $(id).classList.toggle('hide', tab !== name);
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs .tab')) {
    b.classList.toggle('on', b.dataset['tab'] === name);
  }
  $('settingsBtn').classList.toggle('on', name === 'settings');
  $('tabs').classList.toggle('hide', name === 'settings');
}

function showEmpty(message: string, actions?: ReadonlyArray<{ label: string; run: () => void }>): void {
  const host = $('emptyMsg');
  host.textContent = '';
  const p = document.createElement('div');
  p.textContent = message;
  host.append(p);

  if (actions?.length) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:column;gap:7px;margin-top:12px';
    for (const [i, a] of actions.entries()) {
      const b = document.createElement('button');
      b.className = i === 0 ? 'btn pri' : 'btn';
      b.style.width = '100%';
      b.textContent = a.label;
      b.addEventListener('click', a.run);
      row.append(b);
    }
    host.append(row);
  }
  $('emptyPane').classList.remove('hide');
  $('filesPane').classList.add('hide');
}

/** Rate-limit failures get ways out, not just an error string. */
function explainFailure(e: unknown, retry: () => void): void {
  const msg = e instanceof Error ? e.message : String(e);
  const limited = /rate limit|60 requests|throttl|\b(403|406|429)\b/i.test(msg);
  const unauthorized = /\b401\b|token is wrong|revoked/i.test(msg);

  if (unauthorized) {
    showEmpty(`${msg}\n\nThe saved token was rejected. Test or replace it in settings.`, [
      { label: 'Open settings', run: () => showPane('settings') },
      { label: 'Retry', run: retry },
    ]);
    return;
  }
  if (limited) {
    showEmpty(
      `${msg}\n\nThis limit is per IP address, so on a shared network it can be spent before you start.`,
      [
        { label: 'Add a token', run: () => showPane('settings') },
        { label: 'Retry now', run: retry },
        { label: 'Open a different repository', run: () => $('urlInput').focus() },
      ],
    );
    return;
  }
  showEmpty(msg, [{ label: 'Retry', run: retry }]);
}

/* ------------------------------------------------------------------- load */

interface Target { forge: ForgeId; project: string; ref?: string; reload?: boolean }

/** Parsing lives in core so the worker and the panel agree on it. */
async function parse(input: string): Promise<Target | null> {
  const { target } = await send<{ target: Target | null }>({ kind: 'parse', input });
  return target;
}

async function load(t: Target): Promise<void> {
  $('emptyPane').classList.add('hide');
  $('filesPane').classList.remove('hide');
  rows = [];
  $('tree').textContent = '';
  const loading = document.createElement('div');
  loading.className = 'err';
  loading.style.cssText = 'display:flex;gap:8px;align-items:center';
  loading.append(Object.assign(document.createElement('span'), { className: 'spin' }));
  loading.append(document.createTextNode(' Reading the file tree\u2026'));
  $('tree').append(loading);

  try {
    const res = await send<{
      tree: RepoTree; defaultExcludes: string[]; sizesUnknown: boolean;
      snapshot: { requestedRef: string; resolvedCommit: string };
      rate: { remaining: number; limit: number } | null;
    }>({
      kind: 'tree', forge: t.forge, project: t.project,
      ...(t.ref ? { ref: t.ref } : {}),
      ...(t.reload ? { reload: true } : {}),
    });

    S.forge = t.forge; S.project = t.project; S.tree = res.tree;
    S.ref = res.snapshot.requestedRef;
    S.commit = res.snapshot.resolvedCommit;
    // A new snapshot invalidates anything derived from the previous one.
    S.digestId = null; S.jobId = null; S.readmeText = ''; S.digestText = '';
    S.overrides = {}; S.collapsed = {};
    if (S.rules.length === 0) {
      S.rules = res.defaultExcludes.map((g) => ({ glob: g, on: true, mode: 'exclude' as const }));
    }

    const cut = t.project.lastIndexOf('/');
    const owner = $('owner');
    owner.textContent = `${t.project.slice(0, cut)} /`;
    owner.classList.remove('hide');
    $('repo').textContent = t.project.slice(cut + 1);
    // Show the ref the user asked for, and the commit it actually resolved to,
    // so an export can always be traced to one revision.
    const refPill = $('ref');
    refPill.textContent =
      `${res.snapshot.requestedRef} @ ${res.snapshot.resolvedCommit.slice(0, 7)}`;
    refPill.title = `Pinned to commit ${res.snapshot.resolvedCommit}`;
    refPill.classList.remove('hide');
    $('fileCount').textContent = `${fmt(res.tree.files.length)} files`;
    showRate(res.rate);

    const warnHost = $('treeWarn');
    warnHost.textContent = '';
    if (res.sizesUnknown) {
      const w = document.createElement('div');
      w.className = 'note w';
      w.style.margin = '10px 14px';
      w.textContent =
        'GitLab throttled the archive download, so this listing came from its tree API — ' +
        'which reports no file sizes. Per-file token figures are unavailable until the ' +
        'digest is built. Adding a GitLab token avoids this.';
      warnHost.append(w);
    }
    if (res.tree.truncated) {
      const warn = document.createElement('div');
      warn.className = 'note d';
      warn.style.margin = '10px 14px';
      warn.textContent =
        'GitHub truncated this file listing (over 100,000 entries or 7MB). Files beyond that cap cannot be listed or included.';
      warnHost.append(warn);
    }

    renderRules(); renderTree(); renderTotals();
  } catch (e) {
    explainFailure(e, () => void load(t));
  }
}

/* ------------------------------------------------------------------ wiring */

function splitBudget(): number | null {
  if (!($('splitOn') as HTMLInputElement).checked) return null;
  const n = Number(($('splitBudget') as HTMLInputElement).value.replace(/[^0-9]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Re-render the current format and part from the digest already in the worker. */
function refreshOutput(): void {
  const budget = splitBudget();
  for (const b of document.querySelectorAll<HTMLButtonElement>('#formats button')) {
    b.classList.toggle('on', b.dataset['fmt'] === S.format);
  }
  if (S.digestId === null) return;
  void send<{ text: string; part: number; parts: number }>({
    kind: 'render',
    digestId: S.digestId,
    format: S.format,
    ...(budget ? { budget, part: S.part } : {}),
  })
    .then((res) => {
      S.digestText = res.text;
      S.part = res.part;
      S.parts = res.parts;
      $('out').textContent = res.text.slice(0, 40_000);
      $('outSize').textContent = `${(res.text.length / 1e6).toFixed(2)} MB · ${S.format}`;
      $('partLabel').textContent = res.parts > 1 ? `part ${res.part} of ${res.parts}` : 'single part';
      ($('partPrev') as HTMLButtonElement).disabled = res.part <= 1;
      ($('partNext') as HTMLButtonElement).disabled = res.part >= res.parts;
    })
    .catch(() => { /* no digest yet */ });
}

function setFormat(f: Format): void {
  S.format = f;
  refreshOutput();
}

function wire(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs .tab')) {
    b.addEventListener('click', () => showPane(b.dataset['tab']!));
  }
  $('settingsBtn').addEventListener('click', () => {
    const open = !$('settingsPane').classList.contains('hide');
    showPane(open ? 'files' : 'settings');
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('#formats button')) {
    b.addEventListener('click', () => setFormat(b.dataset['fmt'] as Format));
  }
  $('splitOn').addEventListener('change', () => { S.part = 1; refreshOutput(); });
  $('splitBudget').addEventListener('change', () => { S.part = 1; refreshOutput(); });
  $('partPrev').addEventListener('click', () => { if (S.part > 1) { S.part--; refreshOutput(); } });
  $('partNext').addEventListener('click', () => { if (S.part < S.parts) { S.part++; refreshOutput(); } });

  $('tree').addEventListener('scroll', onScroll, { passive: true });

  let filterTimer = 0;
  $('filter').addEventListener('input', (e) => {
    S.filter = (e.target as HTMLInputElement).value;
    // Rebuilding the tree over 26k paths per keystroke is wasteful; coalesce.
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      $('tree').scrollTop = 0;
      renderTree();
    }, 90) as unknown as number;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      $('filter').focus();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate();
  });

  $('genBtn').addEventListener('click', () => void generate());
  $('modeRepo').addEventListener('click', () => {
    $('modeRepo').classList.add('on'); $('modeChanges').classList.remove('on');
    $('tabs').classList.remove('hide');
    showPane('files');
  });
  $('modeChanges').addEventListener('click', () => {
    $('modeChanges').classList.add('on'); $('modeRepo').classList.remove('on');
    $('tabs').classList.add('hide');
    showPane('changes');
  });
  $('diffGo').addEventListener('click', () => void loadChanges());
  $('diffSpec').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void loadChanges();
  });
  $('diffCopy').addEventListener('click', () => {
    void navigator.clipboard.writeText(S.diffText).then(() => {
      $('diffCopy').textContent = 'Copied';
      setTimeout(() => ($('diffCopy').textContent = 'Copy'), 1200);
    });
  });
  $('diffSave').addEventListener('click', () => {
    const blob = new Blob([S.diffText], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${S.project.replace(/\//g, '-')}-changes.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('readmeBtn').addEventListener('click', () => void prepareReadme());
  $('readmeStart').addEventListener('click', () => void startReadme());
  $('readmeCancel').addEventListener('click', () => {
    hidePlan();
    setReadmeStatus('Cancelled. Nothing was sent.', '');
  });
  $('readmeCopy').addEventListener('click', () => {
    void navigator.clipboard.writeText(S.readmeText).then(() => {
      $('readmeCopy').textContent = 'Copied';
      setTimeout(() => ($('readmeCopy').textContent = 'Copy'), 1200);
    });
  });
  $('readmeSave').addEventListener('click', () => {
    const blob = new Blob([S.readmeText], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'README.md';
    a.click();
    URL.revokeObjectURL(a.href);
  });


  $('openBtn').addEventListener('click', () => {
    const v = ($('urlInput') as HTMLInputElement).value.trim();
    void parse(v).then((t) => {
      if (t) return load(t);
      showEmpty(
        'That does not look like a repository. Try a github.com or gitlab.com URL, ' +
          '"owner/repo", or "gitlab:group/subgroup/project".',
      );
      return undefined;
    });
  });

  $('copyBtn').addEventListener('click', () => {
    void navigator.clipboard.writeText(S.digestText).then(() => {
      $('copyBtn').textContent = 'Copied';
      setTimeout(() => ($('copyBtn').textContent = 'Copy'), 1200);
    });
  });

  $('saveBtn').addEventListener('click', () => {
    const ext = S.format === 'txt' ? 'txt' : S.format;
    const blob = new Blob([S.digestText], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const part = S.parts > 1 ? `-part${S.part}of${S.parts}` : '';
    a.download = `${S.project.replace(/\//g, '-')}-${S.commit.slice(0, 7)}${part}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    void chrome.storage.local.set({ theme: next });
  });

  $('ollamaBtn').addEventListener('click', () => void loadOllama());

  $('diagBtn').addEventListener('click', () => void runDiagnostics());
  $('exactBtn').addEventListener('click', () => void runExactCount());

  $('ruleAddOk').addEventListener('click', addRuleFromInput);
  $('ruleInput').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') addRuleFromInput();
  });
  $('ruleModeEx').addEventListener('click', () => {
    S.ruleMode = 'exclude';
    $('ruleModeEx').classList.add('on'); $('ruleModeIn').classList.remove('on');
  });
  $('ruleModeIn').addEventListener('click', () => {
    S.ruleMode = 'include';
    $('ruleModeIn').classList.add('on'); $('ruleModeEx').classList.remove('on');
  });

  $('presetsBtn').addEventListener('click', () => {
    showPane('presets');
    void renderPresets(); void renderHistory();
  });
  // An inline field rather than prompt(): a modal dialog blocks the panel and
  // is a poor fit for a docked surface.
  $('presetSave').addEventListener('click', () => {
    $('presetNameRow').classList.toggle('hide');
    if (!$('presetNameRow').classList.contains('hide')) $('presetName').focus();
  });
  const commitPreset = (): void => {
    const input = $('presetName') as HTMLInputElement;
    const name = input.value.trim();
    if (!name || !S.project) return;
    void loadPresets().then((all) => {
      const next = [...all.filter((p) => p.name !== name), {
        name, rules: S.rules.map((r) => ({ ...r })), overrides: { ...S.overrides },
      }];
      return chrome.storage.local.set({ [presetKey()]: next });
    }).then(() => {
      input.value = '';
      $('presetNameRow').classList.add('hide');
      $('presetSave').textContent = 'Saved';
      setTimeout(() => ($('presetSave').textContent = 'Save preset'), 1200);
    });
  };
  $('presetNameOk').addEventListener('click', commitPreset);
  $('presetName').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') commitPreset();
  });
}

async function generate(): Promise<void> {
  if (!S.tree) return;
  const btn = $('genBtn') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    const res = await send<{
      summary: {
        files: number; tokens: number; requests: number; strategy: string;
        truncations: Array<{ kind: string; detail: string; paths?: string[] }>;
        redactions: Array<{ path: string; kind: string; count: number }>;
      };
      text: string;
      digestId: string;
    }>({ kind: 'digest', forge: S.forge, project: S.project, commit: S.commit, selection: selection() });

    S.digestId = res.digestId;
    S.digestText = res.text;
    S.part = 1;
    S.format = 'md';
    $('out').textContent = res.text.slice(0, 40_000);
    $('outSize').textContent = `${(res.text.length / 1e6).toFixed(2)} MB · md`;
    refreshOutput();

    const notes: string[] = [];
    for (const t of res.summary.truncations) notes.push(t.detail);
    if (res.summary.redactions.length) {
      const n = res.summary.redactions.reduce((s, r) => s + r.count, 0);
      notes.push(`${n} probable secret(s) redacted before output.`);
    }
    const nEl = $('outNotes');
    nEl.classList.toggle('hide', notes.length === 0);
    nEl.className = notes.length ? 'note w' : 'note w hide';
    nEl.textContent = notes.join(' ');

    void recordHistory(res.summary.files, res.summary.tokens);
    showPane('output');
  } catch (e) {
    showPane('output');
    $('out').textContent = e instanceof Error ? e.message : String(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
}

async function loadOllama(): Promise<void> {
  try {
    const { models } = await send<{ models: Array<{ name: string; contextWindow: number }> }>({ kind: 'ollama' });
    S.ollama = models;
    void renderModelPickers();
    $('ollamaMsg').textContent = models.length
      ? `${models.length} local model(s) found at 127.0.0.1:11434`
      : 'Ollama not running — local models hidden';
    renderTotals();
  } catch {
    $('ollamaMsg').textContent = 'Could not reach Ollama.';
  }
}

const FORGES: ReadonlyArray<{
  id: ForgeId; label: string; placeholder: string; help: string; scope: string;
}> = [
  {
    id: 'github',
    label: 'GitHub',
    placeholder: 'github_pat_… or ghp_…',
    scope: 'Contents: read',
    help: 'Anonymous allows 60 requests an hour, shared by everyone on your IP address.',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    placeholder: 'glpat-…',
    scope: 'read_api',
    help:
      'GitLab throttles anonymous archive downloads aggressively (it answers 406), ' +
      'so a token matters more here than on GitHub.',
  },
];

function statusNote(check: TokenCheck): HTMLElement {
  const note = document.createElement('div');
  note.className = 'note ' + (check.valid ? 'o' : 'd');
  note.style.marginTop = '8px';
  const b = document.createElement('b');
  b.textContent = check.valid ? 'Token works' : 'Token rejected';
  note.append(b, document.createElement('br'), document.createTextNode(check.message));
  if (check.scopes) {
    note.append(document.createElement('br'), document.createTextNode(`Scopes: ${check.scopes}`));
  }
  return note;
}

async function renderForgeTokens(): Promise<void> {
  const host = $('forgeTokens');
  host.textContent = '';
  const stored = await loadTokens();

  for (const f of FORGES) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--line)';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:6px';
    const name = document.createElement('span');
    name.style.cssText = 'font-size:12px;font-weight:500';
    name.textContent = f.label;
    const tag = document.createElement('span');
    tag.className = 'pill';
    tag.textContent = stored[f.id] ? 'token saved' : 'anonymous';
    head.append(name, tag);
    wrap.append(head);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const fld = document.createElement('div');
    fld.className = 'fld';
    fld.style.flex = '1';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = f.placeholder;
    input.value = stored[f.id] ?? '';
    fld.append(input);

    const test = document.createElement('button');
    test.className = 'btn';
    test.style.height = '28px';
    test.textContent = 'Test';

    const save = document.createElement('button');
    save.className = 'btn';
    save.style.height = '28px';
    save.textContent = 'Save';

    row.append(fld, test, save);
    wrap.append(row);

    const out = document.createElement('div');
    wrap.append(out);

    test.addEventListener('click', () => {
      out.textContent = '';
      test.disabled = true;
      test.textContent = '…';
      void send<TokenCheck>({
        kind: 'checkToken', forge: f.id, token: input.value,
        ...(f.id === 'gitlab' && stored.gitlabHost ? { host: stored.gitlabHost } : {}),
      })
        .then((check) => out.append(statusNote(check)))
        .catch((e: unknown) => {
          const n = document.createElement('div');
          n.className = 'note d';
          n.style.marginTop = '8px';
          n.textContent = e instanceof Error ? e.message : String(e);
          out.append(n);
        })
        .finally(() => { test.disabled = false; test.textContent = 'Test'; });
    });

    save.addEventListener('click', () => {
      void saveToken(f.id, input.value.trim()).then(() => {
        save.textContent = 'Saved';
        tag.textContent = input.value.trim() ? 'token saved' : 'anonymous';
        setTimeout(() => (save.textContent = 'Save'), 1200);
      });
    });

    const help = document.createElement('div');
    help.style.cssText = 'font-size:10.5px;color:var(--tx3);line-height:1.5;margin-top:7px';
    help.textContent = `Needs ${f.scope}. ${f.help}`;
    wrap.append(help);

    if (f.id === 'gitlab') {
      const hostRow = document.createElement('div');
      hostRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:7px';
      const hf = document.createElement('div');
      hf.className = 'fld';
      hf.style.flex = '1';
      const hi = document.createElement('input');
      hi.placeholder = 'gitlab.com (or your self-managed host)';
      hi.value = stored.gitlabHost ?? '';
      hf.append(hi);
      const hb = document.createElement('button');
      hb.className = 'btn';
      hb.style.height = '28px';
      hb.textContent = 'Set host';
      hb.addEventListener('click', () => {
        const host = hi.value.trim();
        void (async () => {
          // Bind to the single origin the user typed; never widen to https://*/*.
          const granted = await requestGitlabHost(host);
          if (!granted) {
            hb.textContent = 'Denied';
            setTimeout(() => (hb.textContent = 'Set host'), 1600);
            return;
          }
          await saveGitlabHost(host);
          hb.textContent = 'Set';
          setTimeout(() => (hb.textContent = 'Set host'), 1200);
        })();
      });
      hostRow.append(hf, hb);
      wrap.append(hostRow);
    }

    host.append(wrap);
  }
}

/** Two independent choices: bulk analysis, and the final synthesis. */
async function renderModelPickers(): Promise<void> {
  const host = $('modelPickers');
  host.textContent = '';
  const { ollama } = { ollama: S.ollama };

  const row = (
    title: string,
    help: string,
    get: () => ModelChoice,
    set: (c: ModelChoice) => void,
  ): void => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:9px 0;border-bottom:1px solid var(--line)';

    const h = document.createElement('div');
    h.style.cssText = 'font-size:12px;font-weight:500;margin-bottom:3px';
    h.textContent = title;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:10.5px;color:var(--tx3);line-height:1.5;margin-bottom:7px';
    sub.textContent = help;
    wrap.append(h, sub);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:6px';

    const prov = document.createElement('select');
    prov.style.cssText =
      'height:28px;border:1px solid var(--line2);border-radius:4px;background:var(--panel);color:var(--tx);font:inherit;font-size:11.5px;padding:0 6px';
    for (const p of PROVIDERS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      if (p.id === get().provider) o.selected = true;
      prov.append(o);
    }

    const modelBox = document.createElement('div');
    modelBox.className = 'fld';
    modelBox.style.flex = '1';
    const model = document.createElement('input');
    model.value = get().model;
    model.setAttribute('list', `models-${title.replace(/\W/g, '')}`);
    modelBox.append(model);

    const list = document.createElement('datalist');
    list.id = `models-${title.replace(/\W/g, '')}`;
    const fillList = (id: ProviderId): void => {
      list.textContent = '';
      const suggestions =
        id === 'ollama' ? ollama.map((m) => m.name) : [...providerInfo(id).models];
      for (const m of suggestions) {
        const o = document.createElement('option');
        o.value = m;
        list.append(o);
      }
    };
    fillList(get().provider);

    prov.addEventListener('change', () => {
      const id = prov.value as ProviderId;
      const first =
        id === 'ollama' ? (ollama[0]?.name ?? '') : (providerInfo(id).models[0] ?? '');
      model.value = first;
      fillList(id);
      set({ provider: id, model: first });
      invalidatePlan();
    });
    model.addEventListener('change', () => { set({ provider: prov.value as ProviderId, model: model.value.trim() }); invalidatePlan(); });

    controls.append(prov, modelBox, list);
    wrap.append(controls);
    host.append(wrap);
  };

  row(
    'Analysis model',
    'Reads every chunk of code. This is the bulk of the cost — a cheap, fast model is usually right.',
    () => S.mapChoice,
    (c) => { S.mapChoice = c; void chrome.storage.local.set({ mapChoice: c }); },
  );
  row(
    'Synthesis model',
    'Writes the final README from the analysis notes. One call, and where quality shows.',
    () => S.reduceChoice,
    (c) => { S.reduceChoice = c; void chrome.storage.local.set({ reduceChoice: c }); },
  );
}

function renderKeyFields(saved: Record<string, string>): void {
  const host = $('keyFields');
  host.textContent = '';

  for (const p of EXACT_SUPPORT) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:9px 0;border-bottom:1px solid var(--line)';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:6px';
    const name = document.createElement('span');
    name.style.cssText = 'font-size:12px;font-weight:500';
    name.textContent = p.label;
    head.append(name);

    // What the key actually buys. Every provider here can generate a README;
    // only some can also count tokens exactly.
    const readme = document.createElement('span');
    readme.className = 'pill';
    readme.textContent = 'README';
    head.append(readme);
    if (p.exact) {
      const exact = document.createElement('span');
      exact.className = 'pill';
      exact.style.color = 'var(--ok)';
      exact.textContent = 'exact counts';
      head.append(exact);
    }
    wrap.append(head);

    // Every provider that needs a key gets a field. Previously OpenAI and xAI
    // had none, which left no way to use them for README generation at all.
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const fld = document.createElement('div');
    fld.className = 'fld';
    fld.style.flex = '1';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder =
      p.provider === 'anthropic' ? 'sk-ant-…'
      : p.provider === 'google' ? 'AIza… (Google AI Studio)'
      : p.provider === 'openai' ? 'sk-…'
      : 'xai-…';
    input.value = saved[p.provider] ?? '';
    fld.append(input);

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.height = '28px';
    btn.textContent = 'Save';
    btn.addEventListener('click', () => {
      const value = input.value.trim();
      // Host access is requested here, on the click, because that is the
      // moment the user actually enables this provider.
      void (async () => {
        if (value) {
          const granted = await requestProviderAccess(p.provider);
          if (!granted) {
            btn.textContent = 'Denied';
            setTimeout(() => (btn.textContent = 'Save'), 1600);
            return;
          }
        }
        const got = await chrome.storage.local.get('keys');
        const keys = { ...(got['keys'] as Record<string, string> | undefined) };
        if (value) keys[p.provider] = value;
        else delete keys[p.provider];
        await chrome.storage.local.set({ keys });
        btn.textContent = value ? 'Saved' : 'Removed';
        setTimeout(() => (btn.textContent = 'Save'), 1200);
      })();
    });
    row.append(fld, btn);
    wrap.append(row);

    const note = document.createElement('div');
    note.style.cssText = 'font-size:10.5px;color:var(--tx3);line-height:1.5;margin-top:6px';
    note.textContent = p.note;
    wrap.append(note);
    host.append(wrap);
  }

  // Ollama takes no key; say so rather than leaving a gap where a row should be.
  const local = document.createElement('div');
  local.style.cssText = 'padding:9px 0';
  const lh = document.createElement('div');
  lh.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:4px';
  const ln = document.createElement('span');
  ln.style.cssText = 'font-size:12px;font-weight:500';
  ln.textContent = 'Ollama';
  const lp = document.createElement('span');
  lp.className = 'pill';
  lp.textContent = 'no key needed';
  lh.append(ln, lp);
  const lnote = document.createElement('div');
  lnote.style.cssText = 'font-size:10.5px;color:var(--tx3);line-height:1.5';
  lnote.textContent =
    'Runs on your machine, so nothing is sent anywhere and nothing is charged. ' +
    'Context windows are read from the running server and are exact.';
  local.append(lh, lnote);
  host.append(local);
}


function setReadmeStatus(text: string, kind: '' | 'w' | 'd' | 'o' = ''): void {
  const n = $('readmeStatus');
  n.className = `note ${kind}`.trim();
  n.textContent = text;
}

interface ReadmeJobStatus {
  status: 'none' | 'running' | 'done' | 'error';
  done: number; total: number; label: string;
  markdown?: string; error?: string;
  calls?: number; inputTokens?: number; outputTokens?: number;
  failures?: Array<{ part: number; error: string }>;
  grounding?: { verified: string[]; unverified: string[] };
}

let readmePoll: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (readmePoll !== null) clearInterval(readmePoll);
  readmePoll = null;
  ($('readmeBtn') as HTMLButtonElement).disabled = false;
}

function applyJob(j: ReadmeJobStatus): void {
  if (j.status === 'running') {
    const pct = j.total > 0 ? Math.round((j.done / j.total) * 100) : 0;
    $('readmeBar').style.width = `${Math.max(3, pct)}%`;
    setReadmeStatus(`${j.label}… (${pct}%)`);
    return;
  }
  if (j.status === 'error') {
    stopPolling();
    $('readmeMeter').classList.add('hide');
    setReadmeStatus(j.error ?? 'The run failed.', 'd');
    return;
  }
  if (j.status === 'done' && j.markdown !== undefined) {
    stopPolling();
    S.readmeText = j.markdown;
    $('readmeOut').textContent = j.markdown.slice(0, 60_000);
    $('readmeBar').style.width = '100%';
    const bogus = j.grounding?.unverified.length ?? 0;
    const failed = j.failures?.length ?? 0;
    setReadmeStatus(
      `${j.calls ?? 0} call(s), ${fmt(j.inputTokens ?? 0)} in / ${fmt(j.outputTokens ?? 0)} out. ` +
        `${j.grounding?.verified.length ?? 0} file reference(s) verified.` +
        (bogus ? ` ${bogus} reference(s) point at files that do not exist — see Unverified references.` : '') +
        (failed ? ` ${failed} chunk(s) failed.` : ''),
      bogus || failed ? 'w' : 'o',
    );
    return;
  }
  if (j.status === 'none') {
    // The worker restarted and lost the run. Say that, rather than leaving a
    // progress bar that never moves.
    stopPolling();
    $('readmeMeter').classList.add('hide');
    setReadmeStatus(
      'The background worker restarted and the run was lost. This can happen on very long runs — try a smaller selection or a larger chunk size.',
      'd',
    );
  }
}

interface PreparedPlan {
  ok: boolean; blocked: boolean;
  planHash?: string;
  snapshot?: { requestedRef: string; resolvedCommit: string };
  parts?: number; calls?: number; files?: number;
  mapInputTokens?: number; mapAllowance?: number; reduceAllowance?: number;
  mapReason: string; reduceReason: string;
  estimatedCostUsd?: number | null; worstCaseCostUsd?: number | null;
  destinations?: string[]; sendsCode?: boolean; sendsNotes?: boolean;
}

let prepared: PreparedPlan | null = null;

function money(v: number | null | undefined): string {
  return v === null || v === undefined ? 'unknown' : `$${v.toFixed(2)}`;
}

function showPlan(p: PreparedPlan): void {
  const host = $('readmePlan');
  host.textContent = '';
  host.classList.remove('hide');

  const add = (label: string, value: string, strong = false): void => {
    const row = document.createElement('div');
    row.className = 'kv';
    const k = document.createElement('span');
    k.textContent = label;
    const v = document.createElement('b');
    v.style.cssText = `font-size:11.5px;${strong ? 'color:var(--dg)' : ''}`;
    v.textContent = value;
    row.append(k, v);
    host.append(row);
  };

  add('Repository', `${S.project} @ ${p.snapshot?.resolvedCommit.slice(0, 7) ?? '?'}`);
  add('Files', String(p.files ?? 0));
  add('Analysis model', `${S.mapChoice.provider} / ${S.mapChoice.model}`);
  add('Synthesis model', `${S.reduceChoice.provider} / ${S.reduceChoice.model}`);
  add('Model calls', `${p.calls ?? 0} over ${p.parts ?? 0} chunk(s)`);
  add('Tokens of code', fmt(p.mapInputTokens ?? 0));
  add('Estimated cost', money(p.estimatedCostUsd));
  add('Worst case', money(p.worstCaseCostUsd), true);

  // The outbound disclosure is the point of this screen.
  const warn = document.createElement('div');
  warn.className = 'note w';
  warn.style.marginTop = '9px';
  const dest = (p.destinations ?? []).filter((d) => d !== 'ollama');
  warn.textContent = dest.length === 0
    ? 'Everything runs locally through Ollama. No code leaves this machine.'
    : p.sendsCode
      ? `Your repository source will be sent to: ${dest.join(', ')}.`
      : `Your code stays local, but code-derived notes will still be sent to: ${dest.join(', ')}.`;
  host.append(warn);

  const caveat = document.createElement('div');
  caveat.style.cssText = 'font-size:10.5px;color:var(--tx3);line-height:1.5;margin-top:8px';
  caveat.textContent =
    (p.estimatedCostUsd === null
      ? 'This provider publishes no rates we have verified, so cost is unknown — only the call count is. '
      : 'Cost is an estimate from token counts that are themselves estimates. ') +
    'Cancelling after a call has been submitted may still incur charges.';
  host.append(caveat);
}

function hidePlan(): void {
  $('readmePlan').classList.add('hide');
  $('readmeConfirm').classList.add('hide');
  prepared = null;
}

/** IMP-04 step 1: prepare. Sends nothing, spends nothing. */
async function prepareReadme(): Promise<void> {
  const btn = $('readmeBtn') as HTMLButtonElement;
  showPane('readme');
  $('readmeOut').textContent = '';
  hidePlan();
  setReadmeStatus('Preparing the plan…');
  btn.disabled = true;

  try {
    const built = await send<{ digestId: string }>({
      kind: 'digest', forge: S.forge, project: S.project, commit: S.commit, selection: selection(),
    });
    S.digestId = built.digestId;

    const localWindow = S.ollama.find((m) => m.name === S.mapChoice.model)?.contextWindow
      ?? S.ollama.find((m) => m.name === S.reduceChoice.model)?.contextWindow;

    const plan = await send<PreparedPlan>({
      kind: 'planReadme', digestId: S.digestId,
      map: S.mapChoice, reduce: S.reduceChoice,
      ...(localWindow !== undefined ? { ollamaWindow: localWindow } : {}),
    });

    if (plan.blocked) {
      setReadmeStatus(`${plan.mapReason} ${plan.reduceReason}`, 'd');
      return;
    }
    prepared = plan;
    showPlan(plan);
    $('readmeConfirm').classList.remove('hide');
    setReadmeStatus('Review the plan, then choose to send.', 'w');
  } catch (e) {
    setReadmeStatus(e instanceof Error ? e.message : String(e), 'd');
  } finally {
    btn.disabled = false;
  }
}

/** IMP-04 step 2: start, using exactly the plan that was reviewed. */
async function startReadme(): Promise<void> {
  if (prepared === null || S.digestId === null) return;
  $('readmeConfirm').classList.add('hide');
  $('readmeMeter').classList.remove('hide');
  $('readmeBar').style.width = '2%';
  setReadmeStatus('Starting…');

  try {
    const started = await send<{ started: boolean; reason?: string; jobId?: string }>({
      kind: 'startReadme', digestId: S.digestId,
      map: S.mapChoice, reduce: S.reduceChoice,
      chunkBudget: prepared.mapAllowance ?? 0,
      reduceAllowance: prepared.reduceAllowance ?? 0,
      planHash: prepared.planHash ?? '',
    });
    if (!started.started) {
      setReadmeStatus(started.reason ?? 'Could not start.', 'w');
      return;
    }
    S.jobId = started.jobId ?? null;
    stopPolling();
    readmePoll = setInterval(() => {
      if (S.jobId === null) return;
      void send<ReadmeJobStatus>({ kind: 'readmeStatus', jobId: S.jobId })
        .then(applyJob)
        .catch(() => { /* worker briefly unavailable; the next tick retries */ });
    }, 1500);
  } catch (e) {
    setReadmeStatus(e instanceof Error ? e.message : String(e), 'd');
  }
}

/* ------------------------------------------------------ IMP-11: changes */

async function loadChanges(): Promise<void> {
  const spec = ($('diffSpec') as HTMLInputElement).value.trim();
  if (!spec) return;
  const btn = $('diffGo') as HTMLButtonElement;
  const note = $('diffNote');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  $('diffList').textContent = '';
  note.classList.add('hide');

  try {
    const d = await send<{
      kind: string; title: string; base: string; head: string;
      files: Array<{ path: string; status: string; additions: number; deletions: number; hasPatch: boolean }>;
      additions: number; deletions: number; tokens: number;
      truncations: Array<{ kind: string; detail: string }>;
      redactions: number; text: string;
    }>({ kind: 'diff', forge: S.forge, project: S.project, spec });

    S.diffText = d.text;
    $('diffTokens').textContent = fmt(d.tokens);
    $('diffStat').textContent = `+${fmt(d.additions)} −${fmt(d.deletions)} · ${d.files.length} files`;

    // Completeness limits are stated BEFORE the export, not after.
    const warnings = d.truncations.map((t) => t.detail);
    if (d.redactions > 0) warnings.push(`${d.redactions} probable secret(s) redacted from the patches.`);
    if (warnings.length > 0) {
      note.className = 'note w';
      note.textContent = warnings.join(' ');
      note.classList.remove('hide');
    }

    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.style.cssText = 'padding:10px 14px;border-bottom:1px solid var(--line)';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:12.5px;font-weight:600';
    title.textContent = d.title;
    const sub = document.createElement('div');
    sub.className = 'm';
    sub.style.cssText = 'font-size:10.5px;color:var(--tx3);margin-top:3px';
    sub.textContent = `${d.base} … ${d.head}`;
    head.append(title, sub);
    frag.append(head);

    for (const f of d.files) {
      const row = document.createElement('div');
      row.className = 'row';
      row.style.position = 'static';
      row.style.paddingLeft = '14px';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = f.path;
      if (f.status === 'removed') nm.style.textDecoration = 'line-through';
      const st = document.createElement('span');
      st.className = 'rule';
      st.textContent = f.hasPatch ? f.status : `${f.status} · no diff`;
      const a = document.createElement('span');
      a.className = 'm';
      a.style.cssText = 'font-size:10px;color:var(--ok);margin-left:7px';
      a.textContent = `+${f.additions}`;
      const r = document.createElement('span');
      r.className = 'm';
      r.style.cssText = 'font-size:10px;color:var(--dg);margin-left:5px';
      r.textContent = `−${f.deletions}`;
      row.append(nm, st, a, r);
      frag.append(row);
    }
    $('diffList').append(frag);
  } catch (e) {
    note.className = 'note d';
    note.textContent = e instanceof Error ? e.message : String(e);
    note.classList.remove('hide');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load changes';
  }
}

async function runExactCount(): Promise<void> {
  const out = $('exactOut');
  const btn = $('exactBtn') as HTMLButtonElement;
  out.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Counting…';
  try {
    if (S.digestId === null) throw new Error('Build a digest first, then count it exactly.');
    const res = await send<{ tokens: number; provider: string; model: string }>({
      kind: 'countExact', digestId: S.digestId, modelId: S.modelId,
    });
    const est = selectedFiles().reduce((n, f) => n + f.tokens, 0);
    const delta = est - res.tokens;
    const pct = res.tokens > 0 ? ((delta / res.tokens) * 100).toFixed(1) : '0';
    const note = document.createElement('div');
    note.className = 'note o';
    const b = document.createElement('b');
    b.textContent = `${fmt(res.tokens)} tokens — exact, from ${res.provider}`;
    note.append(b, document.createElement('br'));
    note.append(
      document.createTextNode(
        `GitScribe estimated ${fmt(est)}, ${delta >= 0 ? 'over' : 'under'} by ${fmt(Math.abs(delta))} (${pct}%).`,
      ),
    );
    out.append(note);
  } catch (e) {
    const note = document.createElement('div');
    note.className = 'note d';
    note.textContent = e instanceof Error ? e.message : String(e);
    out.append(note);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Count exactly';
  }
}

function updateExactHint(): void {
  const provider = providerOf(S.modelId);
  const support = EXACT_SUPPORT.find((p) => p.provider === provider);
  const btn = $('exactBtn') as HTMLButtonElement;
  if (!provider) {
    $('exactHint').textContent =
      'Local models report an exact context window already; their counts need no key.';
    btn.disabled = true;
  } else if (!support?.exact) {
    $('exactHint').textContent = support?.note ?? '';
    btn.disabled = true;
  } else {
    $('exactHint').textContent =
      `Generate a digest first, then ask ${support.label} to count it exactly. Replaces the estimate for this selection.`;
    btn.disabled = false;
  }
}

/** Rate and its separator appear together, or not at all. */
function showRate(rate: { remaining: number; limit: number } | null): void {
  const has = rate !== null;
  $('rate').classList.toggle('hide', !has);
  $('metaDot').classList.toggle('hide', !has);
  if (rate) $('rate').textContent = `${rate.remaining}/${rate.limit} req`;
}

async function refreshRate(): Promise<void> {
  try {
    const { rate } = await send<{ rate: { remaining: number; limit: number } | null }>({ kind: 'rate' });
    showRate(rate);
  } catch { /* nothing loaded yet */ }
}

async function runDiagnostics(): Promise<void> {
  const host = $('diag');
  host.innerHTML = '<div style="display:flex;gap:8px;align-items:center;font-size:11px"><span class="spin"></span> Checking…</div>';
  try {
    const { steps } = await send<{ steps: Array<{ step: string; ok: boolean; detail: string }> }>({ kind: 'diagnose' });
    host.textContent = '';
    for (const s of steps) {
      const d = document.createElement('div');
      d.className = 'note ' + (s.ok ? 'o' : 'd');
      d.style.marginBottom = '7px';
      const t = document.createElement('b');
      t.textContent = `${s.ok ? 'PASS' : 'FAIL'} — ${s.step}`;
      d.append(t, document.createElement('br'));
      d.append(document.createTextNode(s.detail));
      host.append(d);
    }
  } catch (e) {
    host.textContent = e instanceof Error ? e.message : String(e);
  }
}

/* -------------------------------------------------------------------- init */

async function init(): Promise<void> {
  // wire() touching one missing element used to throw and abort init entirely,
  // leaving a panel that said "No repository open" on a page it could read.
  const guard = async <T>(label: string, fn: () => T | Promise<T>): Promise<void> => {
    try { await fn(); } catch (e) { console.error(`GitScribe: ${label} failed`, e); }
  };
  void guard;
  const { theme, keys, mapChoice, reduceChoice } = await chrome.storage.local.get([
    'theme', 'keys', 'mapChoice', 'reduceChoice',
  ]);
  if (mapChoice) S.mapChoice = mapChoice as ModelChoice;
  if (reduceChoice) S.reduceChoice = reduceChoice as ModelChoice;
  renderKeyFields((keys as Record<string, string> | undefined) ?? {});
  void renderForgeTokens();
  void renderModelPickers();
  document.documentElement.setAttribute('data-theme', typeof theme === 'string' ? theme : 'light');

  await guard('wire', () => wire());
  await guard('exact hint', () => updateExactHint());
  void loadOllama();
  void refreshRate();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const target = tab?.url ? await parse(tab.url) : null;
  if (target) await load(target);
  else showEmpty('This tab is not a GitHub or GitLab repository. Paste a repository URL below.');
}

void init();
