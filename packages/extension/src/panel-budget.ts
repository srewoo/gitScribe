import { DEFAULT_RESERVE, MODELS, suggestDrops, type ModelEntry, type TreeFile, usableWindow } from '@gitscribe/core';
import { updateExactHint } from './panel-extras.js';
import { $, S, currentModel, fmt, kfmt, selectedFiles, sizesUnknown } from './panel-state.js';
import { renderTree } from './panel-tree.js';

export function renderTotals(): void {
  const files = selectedFiles();
  const total = files.reduce((n, f) => n + f.tokens, 0);
  const m = currentModel();
  const usable = usableWindow(m, DEFAULT_RESERVE);
  const ratio = usable > 0 ? total / usable : 0;

  $('total').textContent = sizesUnknown() ? '?' : fmt(total);
  $('selCount').textContent = `${fmt(files.length)} of ${fmt(S.tree?.files.length ?? 0)} files · ${m.name}`;
  if (sizesUnknown()) {
    $('pct').textContent = 'size unknown';
    $('pct').style.color = 'var(--tx3)';
    $('meter').className = 'meter';
    $('bar').style.width = '0%';
    renderBudget(total, usable, m, files);
    return;
  }
  $('pct').textContent = `${Math.round(ratio * 100)}% of window`;
  $('pct').style.color = ratio > 1 ? 'var(--dg)' : ratio > 0.85 ? 'var(--warn)' : 'var(--tx2)';
  $('meter').className = 'meter' + (ratio > 1 ? ' d' : ratio > 0.85 ? ' w' : '');
  $('bar').style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`;

  renderBudget(total, usable, m, files);
}

export function renderBudget(total: number, usable: number, m: ModelEntry, files: TreeFile[]): void {
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
    const verdict = sizesUnknown()
      ? '<span style="font-size:10px;width:42px;text-align:right;color:var(--tx3)">?</span>'
      : `<span style="font-size:10px;width:42px;text-align:right;color:${
        fits ? 'var(--ok)' : 'var(--dg)'
      }">${fits ? 'fits' : `+${kfmt(total - u)}`}</span>`;
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
      `<span class="m" style="font-size:11px;color:var(--tx2)">${kfmt(e.window)}</span>` + verdict;
    // textContent for model-supplied strings, so a repo can never inject markup
    const spans = row.querySelectorAll('span > span');
    (spans[0] as HTMLElement).textContent = e.name;
    (spans[1] as HTMLElement).textContent = e.note ? `${e.vendor} · ${e.note}` : e.vendor;
    row.addEventListener('click', () => { S.modelId = e.id; renderTotals(); updateExactHint(); });
    host.append(row);
  }

  const note = $('advice');
  if (sizesUnknown()) {
    note.className = 'note w';
    note.textContent =
      'Token counts are unknown: GitLab\u2019s tree API reports no file sizes. ' +
      'Build the raw digest to get real counts.';
    $('drops').textContent = '';
    return;
  }
  const over = total - usable;
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
