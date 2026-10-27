import { type Format } from '@gitscribe/core';
import { showPane } from './panel-load.js';
import { recordHistory } from './panel-presets.js';
import { $, S, selection, send } from './panel-state.js';

/* ------------------------------------------------------------------ wiring */

export function splitBudget(): number | null {
  if (!($('splitOn') as HTMLInputElement).checked) return null;
  const n = Number(($('splitBudget') as HTMLInputElement).value.replace(/[^0-9]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Re-render the current format and part from the digest already in the worker. */
export function refreshOutput(): void {
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

export function setFormat(f: Format): void {
  S.format = f;
  refreshOutput();
}

export async function generate(): Promise<void> {
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
