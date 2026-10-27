import type { Layout, PlacedBox } from './diagram-layout.js';

/**
 * Draw a laid-out diagram as one self-contained SVG and make it explorable.
 *
 * Colours are resolved from the panel theme at draw time and written as plain
 * attributes, so an exported SVG/PNG looks the same outside the extension.
 * Every box is `[data-box]` and every arrow `[data-link]` with `data-from` /
 * `data-to`: the walkthrough video addresses elements through these.
 */

const NS = 'http://www.w3.org/2000/svg';

export interface Palette { bg: string; panel: string; line: string; tx: string; tx2: string; tx3: string; ac: string; p2: string }

export function palette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: v('--bg', '#FAFAF9'), panel: v('--panel', '#FFFFFF'), line: v('--line2', '#D6D2CB'),
    tx: v('--tx', '#1F1F1D'), tx2: v('--tx2', '#6B6862'), tx3: v('--tx3', '#93908A'),
    ac: v('--ac', '#1D4E6F'), p2: v('--p2', '#F7F6F4'),
  };
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function text(x: number, y: number, s: string, size: number, fill: string, weight = 400): SVGTextElement {
  const t = el('text', {
    x, y, 'font-size': size, fill, 'font-weight': weight, 'text-anchor': 'middle',
    'font-family': 'ui-sans-serif, system-ui, -apple-system, sans-serif',
  });
  t.textContent = s;   // textContent: a label can never inject markup
  return t;
}

function pathFor(points: ReadonlyArray<{ x: number; y: number }>): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

export function renderSvg(layout: Layout): SVGSVGElement {
  const c = palette();
  const svg = el('svg', {
    xmlns: NS, viewBox: `0 0 ${layout.width} ${layout.height}`,
    width: layout.width, height: layout.height, role: 'group', 'aria-label': 'Code diagram',
  });
  svg.append(el('rect', { x: 0, y: 0, width: layout.width, height: layout.height, fill: c.bg }));

  const defs = el('defs', {});
  const marker = el('marker', { id: 'gs-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  marker.append(el('path', { d: 'M0,0 L10,5 L0,10 z', fill: c.tx3 }));
  defs.append(marker);
  svg.append(defs);

  for (const k of layout.clusters) {
    const g = el('g', { 'data-cluster': k.id });
    g.append(el('rect', { x: k.x - k.w / 2, y: k.y - k.h / 2, width: k.w, height: k.h, rx: 6, fill: c.p2, stroke: c.line, 'stroke-dasharray': '4 3' }));
    const t = text(k.x - k.w / 2 + 8, k.y - k.h / 2 + 12, k.title, 10, c.tx2, 600);
    t.setAttribute('text-anchor', 'start');
    g.append(t);
    svg.append(g);
  }

  for (const l of layout.links) {
    const g = el('g', { 'data-link': '', 'data-from': l.from, 'data-to': l.to });
    g.append(el('path', {
      d: pathFor(l.points), fill: 'none', stroke: c.tx3,
      'stroke-width': Math.min(4, 1 + Math.log2(l.weight)), 'marker-end': 'url(#gs-arrow)',
      ...(l.dashed ? { 'stroke-dasharray': '5 4' } : {}),
    }));
    const mid = l.points[Math.floor(l.points.length / 2)];
    if (l.verb && mid) g.append(text(mid.x, mid.y - 3, l.verb, 9, c.tx2));
    svg.append(g);
  }

  for (const b of layout.boxes) svg.append(boxElement(b, c));
  return svg;
}

function boxElement(b: PlacedBox, c: Palette): SVGGElement {
  const g = el('g', {
    'data-box': b.id, tabindex: -1, role: 'button', class: 'gs-box',
    'aria-label': `${b.title}${b.sub ? `, ${b.sub}` : ''}${b.files.length > 1 ? ', folder, press Enter to expand' : ''}`,
  });
  g.append(el('rect', {
    x: b.x - b.w / 2, y: b.y - b.h / 2, width: b.w, height: b.h, rx: b.entry ? b.h / 2 : 5,
    fill: c.panel, stroke: b.files.length > 1 ? c.ac : c.line, 'stroke-width': b.files.length > 1 ? 1.6 : 1,
  }));
  const titleY = b.sub ? b.y - 3 : b.y + 4;
  g.append(text(b.x, titleY, b.title, 11, c.tx, 500));
  if (b.sub) g.append(text(b.x, b.y + 12, b.sub, 9.5, c.tx3));
  return g;
}

/** Hover highlights a box's arrows; wheel zooms; drag pans; arrows/Enter for keyboards. */
export function makeInteractive(
  svg: SVGSVGElement,
  layout: Layout,
  on: { activate: (box: PlacedBox) => void },
  viewport: { width: number; height: number },
): { fit(): void } {
  let vb = { x: 0, y: 0, w: layout.width, h: layout.height };
  const apply = (): void => svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  const aspect = viewport.width / Math.max(1, viewport.height);
  const fit = (): void => {
    const w = Math.max(layout.width, layout.height * aspect);
    const h = w / aspect;
    vb = { x: (layout.width - w) / 2, y: (layout.height - h) / 2, w, h };
    apply();
  };
  // Opening fully zoomed out can leave 11px text at 3px. Below a readable
  // scale, start at the top-left at that scale instead; Fit shows everything.
  const READABLE = 0.75;
  const fitScale = viewport.width / Math.max(layout.width, layout.height * aspect);
  if (fitScale >= READABLE) fit();
  else {
    vb = { x: 0, y: 0, w: viewport.width / READABLE, h: viewport.height / READABLE };
    apply();
  }
  svg.style.cursor = 'grab';
  svg.style.touchAction = 'none';

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    const k = Math.exp(e.deltaY * 0.0015);
    const w = Math.min(layout.width * 4, Math.max(80, vb.w * k));
    const h = (w / vb.w) * vb.h;
    vb = { x: vb.x + (vb.w - w) * fx, y: vb.y + (vb.h - h) * fy, w, h };
    apply();
  }, { passive: false });

  let drag: { x: number; y: number; vx: number; vy: number } | null = null;
  svg.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('[data-box]')) return;
    drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y };
    svg.setPointerCapture(e.pointerId);
    svg.style.cursor = 'grabbing';
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = svg.getBoundingClientRect();
    vb = { ...vb, x: drag.vx - ((e.clientX - drag.x) * vb.w) / r.width, y: drag.vy - ((e.clientY - drag.y) * vb.h) / r.height };
    apply();
  });
  svg.addEventListener('pointerup', () => { drag = null; svg.style.cursor = 'grab'; });

  const links = [...svg.querySelectorAll<SVGGElement>('[data-link]')];
  const highlight = (id: string | null): void => {
    for (const l of links) {
      const on = id !== null && (l.dataset['from'] === id || l.dataset['to'] === id);
      l.style.opacity = id === null || on ? '1' : '0.15';
      l.querySelector('path')?.setAttribute('stroke-opacity', on ? '1' : '0.85');
    }
  };

  // Reading order for the keyboard: top to bottom, then left to right.
  const order = [...layout.boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const nodes = new Map([...svg.querySelectorAll<SVGGElement>('[data-box]')].map((n) => [n.dataset['box']!, n]));
  order.forEach((b, i) => nodes.get(b.id)?.setAttribute('tabindex', i === 0 ? '0' : '-1'));

  for (const [i, b] of order.entries()) {
    const n = nodes.get(b.id);
    if (!n) continue;
    n.style.cursor = b.entry ? 'default' : 'pointer';
    n.addEventListener('mouseenter', () => highlight(b.id));
    n.addEventListener('mouseleave', () => highlight(null));
    n.addEventListener('focus', () => highlight(b.id));
    n.addEventListener('blur', () => highlight(null));
    n.addEventListener('click', () => { if (!b.entry) on.activate(b); });
    n.addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (step) {
        e.preventDefault();
        const next = nodes.get(order[Math.min(order.length - 1, Math.max(0, i + step))]!.id);
        n.setAttribute('tabindex', '-1');
        next?.setAttribute('tabindex', '0');
        next?.focus();
      } else if (e.key === 'Enter' && !b.entry) {
        e.preventDefault();
        on.activate(b);
      }
    });
  }
  return { fit };
}
