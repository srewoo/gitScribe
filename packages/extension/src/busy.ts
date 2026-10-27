/**
 * "Working…" for anything that waits on an AI model.
 *
 * A static line of text looked frozen during an 85-second local-model call, and
 * the button stayed clickable, so a second request could be sent. This shows a
 * spinner, the message and a live elapsed time, and disables the buttons that
 * would start the same work again until it finishes.
 */

/** "0:07", "1:42": minutes and seconds since the work started. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Shown under the message when the model runs on this computer. */
export const LOCAL_HINT = 'Runs on this computer; local models can take a few minutes.';

export interface Busy {
  /** Change the message (e.g. "Reading part 2 of 5…") without resetting the timer. */
  update(label: string): void;
  /** Stop the timer and re-enable the buttons. Leaves the host's text to the caller. */
  stop(): void;
}

export function startBusy(
  host: HTMLElement,
  label: string,
  opts: { hint?: string | undefined; disable?: ReadonlyArray<HTMLButtonElement | null> } = {},
): Busy {
  const started = Date.now();
  const buttons = (opts.disable ?? []).filter((b): b is HTMLButtonElement => b !== null);
  const wasDisabled = buttons.map((b) => b.disabled);
  for (const b of buttons) b.disabled = true;

  host.className = 'note';
  host.textContent = '';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-busy', 'true');
  const line = document.createElement('div');
  line.style.cssText = 'display:flex;align-items:center;gap:8px';
  const spin = document.createElement('span');
  spin.className = 'spin';
  spin.style.flex = 'none';
  const text = document.createElement('span');
  text.textContent = label;
  // The ticking clock is for sighted users; a screen reader hears the message once.
  const time = document.createElement('span');
  time.setAttribute('aria-hidden', 'true');
  time.style.cssText = 'margin-left:auto;color:var(--tx3);font-variant-numeric:tabular-nums';
  time.textContent = formatElapsed(0);
  line.append(spin, text, time);
  host.append(line);
  if (opts.hint) {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10.5px;color:var(--tx3);margin-top:4px';
    hint.textContent = opts.hint;
    host.append(hint);
  }

  const timer = setInterval(() => { time.textContent = formatElapsed(Date.now() - started); }, 1000);
  let stopped = false;
  return {
    update(next: string): void { if (!stopped) text.textContent = next; },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      host.removeAttribute('aria-busy');
      buttons.forEach((b, i) => { b.disabled = wasDisabled[i]!; });
    },
  };
}
