import {
  groupGraph,
  labelRequest,
  validateLabels,
  toMermaid,
  estimateFromText,
  MAX_BOXES,
  type CodeGraph,
  type GraphView,
  type DiagramLabels,
  type Selection,
} from '@gitscribe/core';
import { layoutToFit } from './diagram-layout.js';
import { renderSvg, makeInteractive } from './diagram-svg.js';
import { hasProviderAccess, requestProviderAccess, type ForgeId } from './tokens.js';
import type { ModelChoice } from './llm.js';
import { startBusy, LOCAL_HINT } from './busy.js';

/**
 * The Diagram tab. Loaded lazily the first time the tab opens.
 *
 * Building is free and local: the digest's imports become the arrows. Labelling
 * is optional and gated like README generation — the user sees exactly what is
 * sent (the outline, never code) and to whom, before anything leaves.
 */

export interface DiagramHost {
  send<T>(msg: unknown): Promise<T>;
  state(): {
    forge: ForgeId; project: string; commit: string; selection: Selection;
    synthesis: ModelChoice; gitlabHost?: string | undefined;
  };
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface DiagramState { graph: CodeGraph; view: GraphView; labels?: DiagramLabels }

export function mountDiagram(host: DiagramHost): { show(): void } {
  let graph: CodeGraph | null = null;
  let builtSig = '';
  let raw: string | null = null;           // the model's reply, re-validated on every draw
  let expanded = new Set<string>();
  let view: GraphView | null = null;
  let fit = (): void => undefined;
  let current: DiagramState | null = null;

  const status = (msg: string, kind: '' | 'w' | 'd' | 'o' = ''): void => {
    const n = $('diagramStatus');
    n.className = `note ${kind}`.trim();
    n.textContent = msg;
  };
  const sig = (): string => {
    const s = host.state();
    return JSON.stringify([s.forge, s.project, s.commit, s.selection]);
  };
  const cacheKey = (): string => `diagram:${sig()}`;

  function draw(): void {
    if (!graph) return;
    view = groupGraph(graph, MAX_BOXES, expanded);
    const checked = raw ? validateLabels(view, raw) : null;
    const canvas = $('diagramCanvas');
    const box = { width: canvas.clientWidth || 400, height: canvas.clientHeight || 500 };
    const layout = layoutToFit(view, checked?.labels, box.width / box.height);
    const svg = renderSvg(layout);
    svg.style.cssText = 'width:100%;height:100%;display:block';
    canvas.textContent = '';
    canvas.append(svg);
    fit = makeInteractive(svg, layout, {
      activate: (b) => {
        if (b.files.length > 1) { expanded.add(b.id); draw(); }
        else openFile(b.id);
      },
    }, box).fit;
    report(checked?.dropped ?? [], checked?.warning, checked?.grouped.length ?? 0);
    current = { graph, view, ...(checked ? { labels: checked.labels } : {}) };
    for (const id of ['diagramLabel', 'diagramExport', 'diagramFit', 'diagramVideo']) $(id).classList.remove('hide');
  }

  function report(dropped: readonly string[], warning?: string, grouped = 0): void {
    if (!graph || !view) return;
    const lines = [
      `${graph.nodes.length} source files · ${graph.edges.length} imports · ${view.boxes.length} boxes. ` +
        'Every arrow is an import found in the code.',
    ];
    if (view.mode === 'module') lines.push('Folders with a blue border are grouped: click one to show its files.');
    if (graph.unresolved.length) {
      lines.push(`${graph.unresolved.length} import(s) could not be resolved and are not drawn: ` +
        graph.unresolved.slice(0, 8).map((u) => `${u.from} → ${u.specifier}`).join(', ') +
        (graph.unresolved.length > 8 ? ', …' : ''));
    }
    if (graph.skipped.length) lines.push(`${graph.skipped.length} non-code file(s) left out.`);
    if (graph.external.length) lines.push(`Packages used: ${graph.external.slice(0, 12).join(', ')}${graph.external.length > 12 ? ', …' : ''}.`);
    if (warning) lines.push(warning);
    if (dropped.length) lines.push(`The model tried to add ${dropped.length} thing(s) that are not in the code; ignored: ${dropped.join('; ')}.`);
    if (grouped) lines.push(`${grouped} name(s) were for files inside grouped folders; expand a folder to see them.`);
    $('diagramReport').textContent = lines.join('\n');
  }

  function openFile(path: string): void {
    const s = host.state();
    const p = path.split('/').map(encodeURIComponent).join('/');
    const url = s.forge === 'gitlab'
      ? `https://${s.gitlabHost || 'gitlab.com'}/${s.project}/-/blob/${s.commit}/${p}`
      : `https://github.com/${s.project}/blob/${s.commit}/${p}`;
    void chrome.tabs.create({ url });
  }

  async function build(): Promise<void> {
    const s = host.state();
    if (!s.commit) { status('Open a repository first.', 'w'); return; }
    status('Reading the selected files…');
    try {
      const { digestId } = await host.send<{ digestId: string }>({
        kind: 'digest', forge: s.forge, project: s.project, commit: s.commit, selection: s.selection,
      });
      graph = (await host.send<{ graph: CodeGraph }>({ kind: 'graph', digestId })).graph;
      builtSig = sig();
      expanded = new Set();
      const cached = await chrome.storage.session.get(cacheKey()).catch(() => ({}));
      raw = (cached as Record<string, string>)[cacheKey()] ?? null;
      draw();
      status(raw ? 'Built, with the names generated earlier for this commit.' : 'Built from the code. Add plain-English names with “Label with AI”.', 'o');
    } catch (e) {
      status((e as Error).message, 'd');
    }
  }

  function prepareLabel(): void {
    if (!graph || !view) return;
    const s = host.state();
    const req = labelRequest(graph, view);
    const tokens = estimateFromText('outline.md', req);
    $('diagramConfirmText').textContent =
      `Sends the outline — file paths, imports, exported names and each file’s first comment, ` +
      `no code — about ${tokens.toLocaleString()} tokens, to ${s.synthesis.provider} / ${s.synthesis.model} ` +
      `(your Synthesis model in Settings).`;
    $('diagramConfirm').classList.remove('hide');
  }

  async function label(): Promise<void> {
    if (!graph || !view) return;
    $('diagramConfirm').classList.add('hide');
    const s = host.state();
    // Must run inside the click: the permission prompt needs a user gesture.
    if (!(await hasProviderAccess(s.synthesis.provider)) && !(await requestProviderAccess(s.synthesis.provider))) {
      status(`Access to ${s.synthesis.provider} was not granted, so nothing was sent.`, 'w');
      return;
    }
    const busy = startBusy($('diagramStatus'), `Asking ${s.synthesis.model} to name the parts…`, {
      hint: s.synthesis.provider === 'ollama' ? LOCAL_HINT : undefined,
      disable: [$('diagramLabel'), $('diagramBuild'), $('diagramVideo')] as HTMLButtonElement[],
    });
    try {
      const reply = await host.send<{ raw: string }>({
        kind: 'labelDiagram', choice: s.synthesis, request: labelRequest(graph, view),
      });
      raw = reply.raw;
      await chrome.storage.session.set({ [cacheKey()]: raw }).catch(() => undefined);
      busy.stop();
      draw();
      status('Labelled. Names come from the model; boxes and arrows still come only from the code.', 'o');
    } catch (e) {
      busy.stop();
      status((e as Error).message, 'd');
    }
  }

  function save(blob: Blob, ext: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${host.state().project.replace(/\//g, '-')}-diagram.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /** The full diagram, not the zoomed view the user happens to be looking at. */
  function svgText(): string {
    const svg = $('diagramCanvas').querySelector('svg')!.cloneNode(true) as SVGSVGElement;
    svg.setAttribute('viewBox', `0 0 ${svg.getAttribute('width')} ${svg.getAttribute('height')}`);
    svg.removeAttribute('style');
    const text = new XMLSerializer().serializeToString(svg);
    // Never hand over a file that will not open: check it parses as SVG first.
    if (new DOMParser().parseFromString(text, 'image/svg+xml').querySelector('parsererror')) {
      throw new Error('The diagram could not be exported as valid SVG. Please report this; nothing was saved.');
    }
    return text;
  }

  async function exportAs(kind: string): Promise<void> {
    if (!view) return;
    if (kind === 'mermaid') {
      const labels = raw ? validateLabels(view, raw).labels : undefined;
      await navigator.clipboard.writeText(toMermaid(view, labels));
      status('Mermaid copied. It renders in GitHub READMEs and mermaid.live.', 'o');
      return;
    }
    const text = svgText();
    if (kind === 'svg') { save(new Blob([text], { type: 'image/svg+xml' }), 'svg'); return; }
    const img = new Image();
    img.src = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth * 2;
    canvas.height = img.naturalHeight * 2;
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(img.src);
    canvas.toBlob((b) => b && save(b, 'png'), 'image/png');
  }

  $('diagramBuild').addEventListener('click', () => void build());
  // Enabled only once listeners exist: a click during the lazy load was silently lost.
  $<HTMLButtonElement>('diagramBuild').disabled = false;
  $('diagramFit').addEventListener('click', () => fit());
  // The video code (and its encoder library) loads only when first asked for.
  let video: Promise<{ toggle(): void }> | null = null;
  $('diagramVideo').addEventListener('click', () => {
    video ??= import('./video-view.js').then((m) => m.mountVideo({ ...host, diagram: () => current }));
    void video.then((v) => v.toggle());
  });
  $('diagramLabel').addEventListener('click', prepareLabel);
  $('diagramSend').addEventListener('click', () => void label());
  $('diagramCancel').addEventListener('click', () => {
    $('diagramConfirm').classList.add('hide');
    status('Cancelled. Nothing was sent.');
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('#diagramExport [data-export]')) {
    b.addEventListener('click', () => void exportAs(b.dataset['export']!).catch((e: Error) => status(e.message, 'd')));
  }

  return {
    show(): void {
      if (graph && builtSig !== sig()) status('The file selection changed since this diagram was built. Build it again to update.', 'w');
    },
  };
}
