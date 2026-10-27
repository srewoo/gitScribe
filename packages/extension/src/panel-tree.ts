import { visibleRange } from './vwindow.js';
import { renderTotals } from './panel-budget.js';
import { invalidatePlan } from './panel-readme.js';
import { $, S, selection } from './panel-state.js';
import { Row, buildTree, flatten, squash, tally } from './panel-tree-model.js';

/**
 * Row height is fixed in CSS so the window maths is a multiply rather than a
 * measure. Changing .row's height in sidepanel.css means changing this.
 */
export const ROW_H = 24;
export const OVERSCAN = 8;

/** Flattened visible rows. Rebuilt on state change, not on scroll. */
export let rows: Row[] = [];
/** Empty the tree, e.g. while a new repository loads. */
export function clearRows(): void { rows = []; }
export let paintScheduled = false;
/** Index of the row that owns the tab stop. */
export let focusedRow = 0;
/**
 * Whether focus currently lives inside the tree. A scroll repaints the window
 * and destroys the focused node, so focus has to be re-applied afterwards —
 * otherwise jumping to a row that was virtualized out silently loses it.
 */
export let treeFocused = false;

/** Move focus within the tree, scrolling the row into view if virtualized out. */
export function focusRowAt(index: number): void {
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

/**
 * Rebuild the row model, then paint the visible window.
 *
 * ponytail: the model rebuild is O(files) on every toggle — fine to ~30k
 * files. If a monorepo makes toggling feel sticky, make tally() incremental
 * (walk only the ancestors of the changed path) rather than rebuilding.
 */
export function renderTree(): void {
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

export function buildRowEl(r: Row): HTMLElement {
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
  if (r.dir) row.setAttribute('aria-expanded', String(!S.collapsed[r.path]));
  // Mixed state is meaningful on folders; files are simply checked or not.
  row.setAttribute('aria-checked', r.cb === 'on' ? 'true' : r.cb === 'mix' ? 'mixed' : 'false');
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

  /** Check or uncheck: a file by itself, a folder for everything under it. */
  const toggle = (): void => {
    const on = r.cb !== 'on';
    if (r.dir) {
      const prefix = `${r.path}/`;
      for (const f of S.tree?.files ?? []) if (f.path.startsWith(prefix)) S.overrides[f.path] = on;
    } else {
      S.overrides[r.path] = on;
    }
    renderTree();
    renderTotals();
    invalidatePlan();
  };
  const activate = (): void => {
    if (r.dir) {
      S.collapsed[r.path] = !S.collapsed[r.path];
      renderTree();
    } else {
      toggle();
    }
  };
  // A folder row expands on click; only its checkbox selects.
  cb.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
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
        e.preventDefault();
        toggle();
        return;
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
export function paint(): void {
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

export function onScroll(): void {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(() => { paintScheduled = false; paint(); });
}

export function renderRules(): void {
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

export function addRuleFromInput(): void {
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
