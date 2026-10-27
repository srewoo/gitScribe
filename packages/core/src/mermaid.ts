import type { GraphView } from './graph.js';
import { linkKey, type DiagramLabels } from './labels.js';

/**
 * Mermaid source for a diagram — an export format, so it renders in a GitHub
 * README or mermaid.live. Ids are positional (`n0`, `n1`…) so no path can
 * break the syntax; every visible string goes through `text()`.
 */

function text(s: string): string {
  return `"${s.replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ')}"`;
}

export function toMermaid(view: GraphView, labels?: DiagramLabels): string {
  const id = new Map(view.boxes.map((b, i) => [b.id, `n${i}`]));
  const lines = ['flowchart TD'];

  const byCluster = new Map<string, string[]>();
  for (const b of view.boxes) {
    const name = labels?.boxes[b.id];
    const shown = name ? `${name} [${b.label}]` : b.label;
    const node = `${id.get(b.id)}[${text(shown)}]`;
    const list = byCluster.get(b.cluster);
    if (list) list.push(node);
    else byCluster.set(b.cluster, [node]);
  }

  let s = 0;
  for (const [cluster, nodes] of [...byCluster].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!cluster) {
      lines.push(...nodes.map((n) => `  ${n}`));
      continue;
    }
    lines.push(`  subgraph s${s++}[${text(labels?.clusters[cluster] ?? cluster)}]`);
    lines.push(...nodes.map((n) => `    ${n}`));
    lines.push('  end');
  }

  if (labels?.entry) {
    // Dashed, so it never reads as an import: the entry reaches the boxes nothing imports.
    lines.push(`  entry((${text(labels.entry)}))`);
    const imported = new Set(view.links.map((l) => l.to));
    for (const b of view.boxes) if (!imported.has(b.id)) lines.push(`  entry -.-> ${id.get(b.id)}`);
  }
  for (const l of view.links) {
    const verb = labels?.links[linkKey(l.from, l.to)];
    const arrow = l.weight > 3 ? '==>' : '-->';
    lines.push(`  ${id.get(l.from)} ${arrow}${verb ? `|${text(verb)}|` : ''} ${id.get(l.to)}`);
  }
  return lines.join('\n');
}
