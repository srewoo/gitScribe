import { decide, type Selection, type TreeFile } from '@gitscribe/core';
import { S, tokfmt } from './panel-state.js';

/* -------------------------------------------------------------------- tree */

export interface Node {
  name: string; path: string; dir: boolean;
  kids: Map<string, Node>; file?: TreeFile;
  sel: number; total: number; tokens: number;
}

export function buildTree(files: readonly TreeFile[]): Node {
  const root: Node = { name: '', path: '', dir: true, kids: new Map(), sel: 0, total: 0, tokens: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const nm = parts[i]!;
      let next = cur.kids.get(nm);
      if (!next) {
        next = { name: nm, path: parts.slice(0, i + 1).join('/'), dir: true, kids: new Map(), sel: 0, total: 0, tokens: 0 };
        cur.kids.set(nm, next);
      }
      cur = next;
    }
    const leaf = parts[parts.length - 1]!;
    cur.kids.set(leaf, { name: leaf, path: f.path, dir: false, kids: new Map(), file: f, sel: 0, total: 0, tokens: 0 });
  }
  return root;
}

/** Squash single-child directory chains so depth means branching. */
export function squash(n: Node): void {
  for (const child of n.kids.values()) {
    if (!child.dir) continue;
    while (child.kids.size === 1) {
      const only = [...child.kids.values()][0]!;
      if (!only.dir) break;
      child.name = `${child.name}/${only.name}`;
      child.path = only.path;
      child.kids = only.kids;
    }
    squash(child);
  }
}

export function tally(n: Node, sel: Selection): void {
  if (!n.dir) {
    const d = decide(n.file!.path, sel);
    n.total = 1;
    n.sel = d.selected ? 1 : 0;
    n.tokens = d.selected ? n.file!.tokens : 0;
    return;
  }
  n.sel = 0; n.total = 0; n.tokens = 0;
  for (const c of n.kids.values()) {
    tally(c, sel);
    n.sel += c.sel; n.total += c.total; n.tokens += c.tokens;
  }
}

export interface Row {
  index: number;
  key: string;
  name: string;
  dir: boolean;
  depth: number;
  path: string;
  tokens: string;
  excluded: string | null;
  cb: 'on' | 'mix' | '';
  count: string;
  file?: TreeFile;
}

export function flatten(root: Node, sel: Selection): Row[] {
  const out: Row[] = [];
  const walk = (n: Node, depth: number): void => {
    const kids = [...n.kids.values()].sort((a, b) =>
      a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name));

    for (const c of kids) {
      if (c.dir) {
        const all = c.sel === c.total && c.total > 0;
        out.push({
          index: out.length,
          key: `d:${c.path}`, name: c.name, dir: true, depth, path: c.path,
          tokens: tokfmt(c.tokens), excluded: null,
          cb: all ? 'on' : c.sel > 0 ? 'mix' : '',
          count: `${c.sel}/${c.total}`,
        });
        if (!S.collapsed[c.path]) walk(c, depth + 1);
      } else {
        const d = decide(c.file!.path, sel);
        out.push({
          index: out.length,
          key: `f:${c.file!.path}`, name: c.name, dir: false, depth, path: c.file!.path,
          tokens: tokfmt(c.file!.tokens), excluded: d.excludedBy,
          cb: d.selected ? 'on' : '', count: '', file: c.file!,
        });
      }
    }
  };
  walk(root, 0);
  return out;
}
