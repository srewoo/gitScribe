import { type ForgeId } from './tokens.js';
import { type RepoTree } from '@gitscribe/core';
import { renderTotals } from './panel-budget.js';
import { showRate } from './panel-extras.js';
import { $, S, fmt, selection, send } from './panel-state.js';
import { clearRows, renderRules, renderTree } from './panel-tree.js';

/** Diagram code is loaded the first time its tab opens, so start-up stays as fast as before. */
export let diagram: Promise<{ show(): void }> | null = null;
export let gitlabHost: string | undefined;
export function setGitlabHost(host: string | undefined): void { gitlabHost = host; }
export async function openDiagram(): Promise<void> {
  diagram ??= import('./diagram-view.js').then((m) => m.mountDiagram({
    send,
    state: () => ({
      forge: S.forge, project: S.project, commit: S.commit, selection: selection(),
      synthesis: S.reduceChoice, gitlabHost,
    }),
  }));
  (await diagram).show();
}

/* ------------------------------------------------------------------ panes */

export function showPane(name: string): void {
  for (const [id, tab] of [
    ['filesPane', 'files'], ['budgetPane', 'budget'],
    ['outputPane', 'output'], ['settingsPane', 'settings'], ['presetsPane', 'presets'],
    ['readmePane', 'readme'], ['changesPane', 'changes'], ['diagramPane', 'diagram'],
  ] as const) {
    $(id).classList.toggle('hide', tab !== name);
  }
  if (name === 'diagram') void openDiagram();
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs .tab')) {
    b.classList.toggle('on', b.dataset['tab'] === name);
  }
  $('settingsBtn').classList.toggle('on', name === 'settings');
  $('tabs').classList.toggle('hide', name === 'settings');
}

export function showEmpty(message: string, actions?: ReadonlyArray<{ label: string; run: () => void }>): void {
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
export function explainFailure(e: unknown, retry: () => void): void {
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

export interface Target { forge: ForgeId; project: string; ref?: string; reload?: boolean }

/** Parsing lives in core so the worker and the panel agree on it. */
export async function parse(input: string): Promise<Target | null> {
  const { target } = await send<{ target: Target | null }>({ kind: 'parse', input });
  return target;
}

export async function load(t: Target): Promise<void> {
  $('emptyPane').classList.add('hide');
  $('filesPane').classList.remove('hide');
  clearRows();
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
        'GitLab throttled the archive download, and its file sizes could not be looked up, ' +
        'so token figures are unavailable until the digest is built. ' +
        (res.tree.sizesNote ?? 'Try again in a minute.');
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
