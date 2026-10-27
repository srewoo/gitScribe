import type { CodeGraph, GraphView } from './graph.js';
import { labelRequest, linkKey, resolveBox, type DiagramLabels } from './labels.js';
import { checkGrounding } from './grounding.js';
import {
  planTour, finishTour, stopLinks, boxCaption, clusterCaption, clip,
  PRESETS, type Tour, type TourPreset, type TourStop,
} from './tour.js';

/**
 * A model-written tour, held to the same rule as everything else: it may
 * choose the order and the words, but every stop must be a real box or folder,
 * every arrow it lights up must be a real import, and every file it names in a
 * caption must exist. Anything else is cut and reported.
 */

export const TOUR_PROMPT = `You write the script for a short video tour of a codebase's architecture diagram.

You get the diagram's boxes (files or folders), its folders, and its arrows
(imports, taken from the code), plus a list of STOPS you may visit.

Reply with ONE JSON object and nothing else:
{
  "title": "<video title, under 50 characters>",
  "hook":  "<one punchy opening line, under 80 characters>",
  "stops": [
    { "target": "<a STOP id, exactly as listed>",
      "caption": "<what this part does and what it works with, under 110 characters>",
      "links": [ { "from": "<box id>", "to": "<box id>" } ] }
  ]
}

Rules:
- Start where the code starts (pages, entry points), then follow the arrows.
- Use only the listed STOP ids and listed arrows. Never invent or reverse one.
- Only name files that appear in the input. Plain English, present tense.
- Keep the number of stops within the limit you are given.`;

export function tourRequest(g: CodeGraph, view: GraphView, labels: DiagramLabels | undefined, preset: TourPreset = 'onboarding'): string {
  const folders = [...new Set(view.boxes.map((b) => b.cluster).filter(Boolean))];
  const named = (id: string, map?: Readonly<Record<string, string>>): string => (map?.[id] ? ` — ${map[id]}` : '');
  return [
    labelRequest(g, view),
    '',
    `STOPS (at most ${PRESETS[preset].maxStops}; use these ids exactly)`,
    ...view.boxes.map((b) => `- ${b.id}${named(b.id, labels?.boxes)}`),
    ...folders.map((f) => `- ${f}  (folder)${named(f, labels?.clusters)}`),
  ].join('\n');
}

export interface TourResult {
  readonly tour: Tour;
  readonly dropped: readonly string[];
  readonly warning?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parse(raw: string): Record<string, unknown> | undefined {
  const body = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1] ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  try {
    const v: unknown = JSON.parse(body);
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** File names a caption claims, in the form the README checker reads. */
function fakeFiles(caption: string, paths: readonly string[]): readonly string[] {
  const marked = caption.replace(/[\w@./-]+\.[a-z]{1,5}\b/gi, (m) => `\`${m}\``);
  return checkGrounding(marked, paths).unverified;
}

export function validateTour(
  g: CodeGraph,
  view: GraphView,
  labels: DiagramLabels | undefined,
  raw: string,
  preset: TourPreset,
  title: string,
): TourResult {
  const fallback = (why: string, dropped: string[] = []): TourResult => ({
    tour: planTour(g, view, labels, preset, title), dropped,
    warning: `${why} Using the code-only tour instead.`,
  });
  const reply = parse(raw);
  if (!reply || !Array.isArray(reply['stops'])) return fallback('The model reply was not a valid script.');

  const boxes = new Map(view.boxes.map((b) => [b.id, b]));
  const folders = new Set(view.boxes.map((b) => b.cluster).filter(Boolean));
  const real = new Set(view.links.map((l) => linkKey(l.from, l.to)));
  const allPaths = [...g.nodes, ...g.skipped];
  const dropped: string[] = [];
  const stops: Array<Omit<TourStop, 'ms'>> = [];
  const seen = new Set<string>();

  for (const s of reply['stops']) {
    if (!isRecord(s) || typeof s['target'] !== 'string') continue;
    const named = s['target'];
    const target = folders.has(named) && !boxes.has(named) ? named : resolveBox(view, named) ?? named;
    const kind = boxes.has(target) ? 'box' : folders.has(target) ? 'cluster' : null;
    if (!kind) { dropped.push(`stop "${named}" is not in the diagram`); continue; }
    if (seen.has(target)) continue;
    seen.add(target);

    const links: Array<{ from: string; to: string }> = [];
    for (const l of Array.isArray(s['links']) ? s['links'] : []) {
      if (!isRecord(l) || typeof l['from'] !== 'string' || typeof l['to'] !== 'string') continue;
      const from = resolveBox(view, l['from']) ?? l['from'];
      const to = resolveBox(view, l['to']) ?? l['to'];
      if (real.has(linkKey(from, to))) links.push({ from, to });
      else dropped.push(`arrow ${linkKey(from, to)} is not in the code`);
    }
    const ownCaption = kind === 'box' ? boxCaption(g, view, boxes.get(target)!, labels) : clusterCaption(view, target, labels);
    let caption = typeof s['caption'] === 'string' ? clip(s['caption']) : '';
    const fake = caption ? fakeFiles(caption, allPaths) : [];
    if (fake.length) {
      dropped.push(`caption for ${target} named ${fake.join(', ')}, which does not exist`);
      caption = '';
    }
    const members = new Set(kind === 'box' ? [target] : view.boxes.filter((b) => b.cluster === target).map((b) => b.id));
    stops.push({ target, kind, caption: caption || ownCaption, links: links.length ? links : stopLinks(view, members) });
  }

  if (stops.length < 3) return fallback(`Only ${stops.length} of the model's stops exist in the diagram.`, dropped);
  const t = typeof reply['title'] === 'string' && reply['title'].trim() ? clip(reply['title'], 60) : title;
  const hook = typeof reply['hook'] === 'string' ? clip(reply['hook'], 90) : undefined;
  return { tour: finishTour(t, preset, stops.slice(0, PRESETS[preset].maxStops), hook), dropped };
}
