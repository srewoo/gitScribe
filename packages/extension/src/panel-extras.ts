import { EXACT_SUPPORT, providerOf } from './counters.js';
import { $, S, fmt, selectedFiles, send } from './panel-state.js';
import { startBusy } from './busy.js';

/* ------------------------------------------------------ IMP-11: changes */

export async function loadChanges(): Promise<void> {
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

export async function runExactCount(): Promise<void> {
  const out = $('exactOut');
  const btn = $('exactBtn') as HTMLButtonElement;
  btn.textContent = 'Counting…';
  out.textContent = '';
  const slot = document.createElement('div');
  out.append(slot);
  const busy = startBusy(slot, 'Asking the model vendor to count this digest exactly…', { disable: [btn] });
  try {
    if (S.digestId === null) throw new Error('Build a digest first, then count it exactly.');
    const res = await send<{ tokens: number; provider: string; model: string }>({
      kind: 'countExact', digestId: S.digestId, modelId: S.modelId,
    });
    const est = selectedFiles().reduce((n, f) => n + f.tokens, 0);
    const delta = est - res.tokens;
    const pct = res.tokens > 0 ? ((delta / res.tokens) * 100).toFixed(1) : '0';
    busy.stop();
    out.textContent = '';
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
    busy.stop();
    out.textContent = '';
    const note = document.createElement('div');
    note.className = 'note d';
    note.textContent = e instanceof Error ? e.message : String(e);
    out.append(note);
  } finally {
    busy.stop();
    btn.textContent = 'Count exactly';
  }
}

export function updateExactHint(): void {
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
export function showRate(rate: { remaining: number; limit: number } | null): void {
  const has = rate !== null;
  $('rate').classList.toggle('hide', !has);
  $('metaDot').classList.toggle('hide', !has);
  if (rate) $('rate').textContent = `${rate.remaining}/${rate.limit} req`;
}

export async function refreshRate(): Promise<void> {
  try {
    const { rate } = await send<{ rate: { remaining: number; limit: number } | null }>({ kind: 'rate' });
    showRate(rate);
  } catch { /* nothing loaded yet */ }
}

export async function runDiagnostics(): Promise<void> {
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
