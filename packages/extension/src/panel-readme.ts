import { capacityFor } from './llm.js';
import { startBusy, LOCAL_HINT, type Busy } from './busy.js';
import { showPane } from './panel-load.js';
import { $, S, fmt, ollamaWindows, selection, send } from './panel-state.js';

/** A reviewed plan is only valid for what was reviewed. */
export function invalidatePlan(): void {
  if (prepared !== null) {
    hidePlan();
    setReadmeStatus('The selection or model changed — prepare the plan again.', 'w');
  }
}


export function setReadmeStatus(text: string, kind: '' | 'w' | 'd' | 'o' = ''): void {
  const n = $('readmeStatus');
  n.className = `note ${kind}`.trim();
  n.style.whiteSpace = 'pre-line';
  n.textContent = text;
}

export interface ReadmeJobStatus {
  status: 'none' | 'running' | 'done' | 'error';
  done: number; total: number; label: string;
  markdown?: string; error?: string;
  calls?: number; inputTokens?: number; outputTokens?: number;
  failures?: Array<{ part: number; error: string }>;
  grounding?: { verified: string[]; unverified: string[] };
}

export let readmePoll: ReturnType<typeof setInterval> | null = null;
/** The running generation's indicator; progress updates its message, not its timer. */
let readmeBusy: Busy | null = null;

export function stopPolling(): void {
  if (readmePoll !== null) clearInterval(readmePoll);
  readmePoll = null;
  readmeBusy?.stop();
  readmeBusy = null;
  ($('readmeBtn') as HTMLButtonElement).disabled = false;
}

export function applyJob(j: ReadmeJobStatus): void {
  if (j.status === 'running') {
    const pct = j.total > 0 ? Math.round((j.done / j.total) * 100) : 0;
    $('readmeBar').style.width = `${Math.max(3, pct)}%`;
    if (readmeBusy) readmeBusy.update(`${j.label}… (${pct}%)`);
    else setReadmeStatus(`${j.label}… (${pct}%)`);
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

export interface PreparedPlan {
  ok: boolean; blocked: boolean;
  planHash?: string;
  snapshot?: { requestedRef: string; resolvedCommit: string };
  parts?: number; calls?: number; files?: number;
  mapInputTokens?: number; mapAllowance?: number; reduceAllowance?: number;
  mapReason: string; reduceReason: string;
  mapBlocked?: boolean; reduceBlocked?: boolean;
  estimatedCostUsd?: number | null; worstCaseCostUsd?: number | null;
  destinations?: string[]; sendsCode?: boolean; sendsNotes?: boolean;
}

export let prepared: PreparedPlan | null = null;

export function money(v: number | null | undefined): string {
  return v === null || v === undefined ? 'unknown' : `$${v.toFixed(2)}`;
}

export function showPlan(p: PreparedPlan): void {
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
  // Where each window figure came from, so an approximate one is visible here.
  const SOURCE = { vendor: 'vendor docs', runtime: 'measured from Ollama', user: 'entered by you', secondary: 'approximate', unknown: 'unknown' };
  for (const [label, c] of [['Analysis window', S.mapChoice], ['Synthesis window', S.reduceChoice]] as const) {
    const cap = capacityFor(c, ollamaWindows());
    add(label, cap.contextTokens ? `${fmt(cap.contextTokens)} (${SOURCE[cap.source]})` : 'unknown');
  }
  add('Estimated cost', money(p.estimatedCostUsd));
  // Red only when there is something to pay; $0.00 for a local run is not a warning.
  add('Worst case', money(p.worstCaseCostUsd), (p.worstCaseCostUsd ?? 1) > 0);

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
  caveat.textContent = dest.length === 0
    ? 'Runs on this machine, so there is nothing to pay. It may take a few minutes on a laptop.'
    : (p.estimatedCostUsd === null
      ? 'No verified price is on record for this model, so cost is unknown — only the call count is. '
      : 'Cost is an estimate from token counts that are themselves estimates. ') +
      'Cancelling after a call has been submitted may still incur charges.';
  host.append(caveat);
}

export function hidePlan(): void {
  $('readmePlan').classList.add('hide');
  $('readmeConfirm').classList.add('hide');
  prepared = null;
}

/** IMP-04 step 1: prepare. Sends nothing, spends nothing. */
export async function prepareReadme(): Promise<void> {
  const btn = $('readmeBtn') as HTMLButtonElement;
  showPane('readme');
  $('readmeOut').textContent = '';
  hidePlan();
  const busy = startBusy($('readmeStatus'), 'Reading the selected files and preparing the plan… nothing is sent yet.', {
    disable: [btn],
  });

  try {
    const built = await send<{ digestId: string }>({
      kind: 'digest', forge: S.forge, project: S.project, commit: S.commit, selection: selection(),
    });
    S.digestId = built.digestId;

    const plan = await send<PreparedPlan>({
      kind: 'planReadme', digestId: S.digestId,
      map: S.mapChoice, reduce: S.reduceChoice, ollamaWindows: ollamaWindows(),
    });

    busy.stop();
    if (plan.blocked) {
      // Name the model that is blocked; two identical sentences told the user nothing.
      const why = [
        plan.mapBlocked ? `Analysis model (${S.mapChoice.model || 'none'}): ${plan.mapReason}` : '',
        plan.reduceBlocked ? `Synthesis model (${S.reduceChoice.model || 'none'}): ${plan.reduceReason}` : '',
      ].filter(Boolean);
      setReadmeStatus(why.join('\n\n'), 'd');
      return;
    }
    prepared = plan;
    showPlan(plan);
    $('readmeConfirm').classList.remove('hide');
    setReadmeStatus('Review the plan, then choose to send.', 'w');
  } catch (e) {
    busy.stop();
    setReadmeStatus(e instanceof Error ? e.message : String(e), 'd');
  } finally {
    busy.stop();
  }
}

/** IMP-04 step 2: start, using exactly the plan that was reviewed. */
export async function startReadme(): Promise<void> {
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
    const local = S.mapChoice.provider === 'ollama' || S.reduceChoice.provider === 'ollama';
    readmeBusy = startBusy($('readmeStatus'), 'Starting…', {
      hint: local ? LOCAL_HINT : undefined,
      disable: [$('readmeBtn') as HTMLButtonElement],
    });
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
