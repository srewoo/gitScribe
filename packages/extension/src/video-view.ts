import { planTour, tourRequest, validateTour, estimateFromText, type Tour, type TourPreset } from '@gitscribe/core';
import { layoutToFit } from './diagram-layout.js';
import { palette } from './diagram-svg.js';
import { makeScene, drawFrame, type Scene } from './diagram-video.js';
import { encodeTour } from './video-encode.js';
import { hasProviderAccess, requestProviderAccess } from './tokens.js';
import type { DiagramHost, DiagramState } from './diagram-view.js';
import { startBusy, LOCAL_HINT } from './busy.js';

/**
 * The "Make video" controls in the Diagram tab. Loaded on first use, with the
 * encoder library, so neither costs anything until someone asks for a video.
 */

const SIZES = { '16:9': { w: 1920, h: 1080 }, '9:16': { w: 1080, h: 1920 }, '1:1': { w: 1080, h: 1080 } } as const;
type Format = keyof typeof SIZES;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function mountVideo(host: DiagramHost & { diagram(): DiagramState | null }): { toggle(): void } {
  let aiTour: { key: string; tour: Tour; note: string } | null = null;
  let playing = 0;
  let abort: AbortController | null = null;
  /** What the script step reported (e.g. claims it cut); kept above render results. */
  let scriptNote = '';

  const opts = (): { preset: TourPreset; format: Format; ai: boolean } => ({
    preset: $<HTMLSelectElement>('videoPreset').value as TourPreset,
    format: $<HTMLSelectElement>('videoFormat').value as Format,
    ai: $<HTMLSelectElement>('videoScript').value === 'ai',
  });
  const say = (msg: string): void => { $('videoStatus').textContent = msg; };
  const busy = (on: boolean): void => {
    $('videoStop').classList.toggle('hide', !on);
    for (const id of ['videoPlay', 'videoRender']) $<HTMLButtonElement>(id).disabled = on;
  };

  // Share defaults to vertical; onboarding to widescreen.
  $('videoPreset').addEventListener('change', () => {
    $<HTMLSelectElement>('videoFormat').value = opts().preset === 'share' ? '9:16' : '16:9';
  });

  /** The tour for the current options, or null if the AI script still needs approval. */
  function tourNow(d: DiagramState): { tour: Tour; note: string } | null {
    const o = opts();
    const title = host.state().project;
    if (!o.ai) return { tour: planTour(d.graph, d.view, d.labels, o.preset, title), note: 'Script written from the code.' };
    const key = JSON.stringify([o.preset, d.view.boxes.length, d.view.links.length, host.state().commit]);
    return aiTour?.key === key ? aiTour : null;
  }

  function scene(d: DiagramState, tour: Tour): Scene {
    const size = SIZES[opts().format];
    const s = host.state();
    const layout = layoutToFit(d.view, d.labels, size.w / size.h);
    return makeScene(layout, tour, size, palette(), s.project, s.commit, { files: d.graph.nodes.length, imports: d.graph.edges.length });
  }

  async function withTour(then: (d: DiagramState, tour: Tour) => Promise<void>): Promise<void> {
    const d = host.diagram();
    if (!d) { say('Build the diagram first.'); return; }
    const ready = tourNow(d);
    if (ready) { scriptNote = ready.note; say(scriptNote); await then(d, ready.tour); return; }
    const s = host.state();
    const req = tourRequest(d.graph, d.view, d.labels, opts().preset);
    $('videoConfirmText').textContent =
      `Sends the outline and the list of possible stops — no code — about ${estimateFromText('t.md', req).toLocaleString()} ` +
      `tokens, to ${s.synthesis.provider} / ${s.synthesis.model} (your Synthesis model).`;
    $('videoConfirm').classList.remove('hide');
    $('videoSend').onclick = () => void sendScript(d, req).then((t) => t && then(d, t));
  }

  async function sendScript(d: DiagramState, req: string): Promise<Tour | null> {
    $('videoConfirm').classList.add('hide');
    const s = host.state();
    if (!(await hasProviderAccess(s.synthesis.provider)) && !(await requestProviderAccess(s.synthesis.provider))) {
      say(`Access to ${s.synthesis.provider} was not granted, so nothing was sent.`);
      return null;
    }
    const busy = startBusy($('videoStatus'), `Asking ${s.synthesis.model} to write the script…`, {
      hint: s.synthesis.provider === 'ollama' ? LOCAL_HINT : undefined,
      disable: [$('videoPlay'), $('videoRender')] as HTMLButtonElement[],
    });
    try {
      const { raw } = await host.send<{ raw: string }>({ kind: 'labelDiagram', purpose: 'tour', choice: s.synthesis, request: req })
        .finally(() => busy.stop());
      const o = opts();
      const r = validateTour(d.graph, d.view, d.labels, raw, o.preset, s.project);
      const note = [
        r.warning ?? 'Script written by the model; every stop and arrow was checked against the code.',
        r.dropped.length ? `Cut ${r.dropped.length} claim(s) not in the code: ${r.dropped.join('; ')}.` : '',
      ].filter(Boolean).join('\n');
      aiTour = { key: JSON.stringify([o.preset, d.view.boxes.length, d.view.links.length, s.commit]), tour: r.tour, note };
      scriptNote = note;
      say(note);
      return r.tour;
    } catch (e) {
      say((e as Error).message);
      return null;
    }
  }

  async function preview(d: DiagramState, tour: Tour): Promise<void> {
    const sc = scene(d, tour);
    const canvas = $<HTMLCanvasElement>('videoPreview');
    // Preview at reduced resolution; the frames are the same, just smaller.
    const k = Math.min(1, 640 / Math.max(sc.size.w, sc.size.h));
    canvas.width = sc.size.w * k;
    canvas.height = sc.size.h * k;
    canvas.classList.remove('hide');
    const ctx = canvas.getContext('2d')!;
    const start = performance.now();
    const run = ++playing;
    busy(true);
    await new Promise<void>((done) => {
      const tick = (): void => {
        const t = performance.now() - start;
        if (run !== playing || t > tour.totalMs) { done(); return; }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.save();
        ctx.scale(k, k);
        drawFrame(ctx, { ...sc }, t);
        ctx.restore();
        requestAnimationFrame(tick);
      };
      tick();
    });
    busy(false);
  }

  async function render(d: DiagramState, tour: Tour): Promise<void> {
    abort = new AbortController();
    busy(true);
    $('videoMeter').classList.remove('hide');
    const started = performance.now();
    try {
      const out = await encodeTour(scene(d, tour), {
        signal: abort.signal,
        onProgress: (p) => { $('videoBar').style.width = `${(p * 100).toFixed(1)}%`; },
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(out.blob);
      a.download = `${host.state().project.replace(/\//g, '-')}-tour.${out.extension}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      say([
        scriptNote,
        `Rendered ${(tour.totalMs / 1000).toFixed(0)}s of video in ${((performance.now() - started) / 1000).toFixed(1)}s ` +
          `(${(out.blob.size / 1e6).toFixed(1)} MB).`,
        out.fallback ?? '',
        out.silent ?? '',
      ].filter(Boolean).join('\n'));
    } catch (e) {
      say((e as Error).name === 'AbortError' ? 'Rendering cancelled.' : (e as Error).message);
    } finally {
      busy(false);
      $('videoMeter').classList.add('hide');
      abort = null;
    }
  }

  $('videoPlay').addEventListener('click', () => void withTour(preview));
  $('videoRender').addEventListener('click', () => void withTour(render));
  $('videoStop').addEventListener('click', () => { playing++; abort?.abort(); });
  $('videoCancelSend').addEventListener('click', () => {
    $('videoConfirm').classList.add('hide');
    say('Cancelled. Nothing was sent.');
  });

  return {
    toggle(): void { $('videoPanel').classList.toggle('hide'); },
  };
}
