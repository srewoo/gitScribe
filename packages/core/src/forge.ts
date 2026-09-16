import type { RepoTree, RateLimit } from './github.js';

/**
 * The seam between core and a specific hosting provider.
 *
 * GitHub and GitLab are NOT symmetric, and pretending otherwise would produce
 * a lowest-common-denominator client that is wrong about both:
 *
 * - GitHub's trees API returns a `size` per blob, so every file can be costed
 *   before a single byte of content is downloaded. That is what makes the
 *   live-updating total possible.
 * - GitLab's tree API returns no size at all (id, mode, name, path, type), and
 *   paginates at 100 entries. Sizes only exist inside the archive, so a GitLab
 *   tree is built by streaming the archive and reading the tar headers.
 *
 * The interface therefore promises a tree with sizes and an archive stream,
 * and lets each implementation get there its own way. `treeCostsARequest`
 * tells the UI which story to tell the user.
 */
export interface Forge {
  readonly id: 'github' | 'gitlab';
  readonly label: string;
  /** Whether listing the tree already downloads repository content. */
  readonly treeFromArchive: boolean;

  getRepoInfo(project: string): Promise<RepoInfo>;
  getTree(project: string, ref: string): Promise<RepoTree>;
  getArchive(project: string, ref: string): Promise<ReadableStream<Uint8Array>>;
  readonly rateLimit: RateLimit | null;
}

export interface RepoInfo {
  readonly defaultBranch: string;
  readonly private: boolean;
}

/** Parsed from a URL or an `owner/repo` string. */
export interface ForgeTarget {
  readonly forge: 'github' | 'gitlab';
  /** `owner/repo` for GitHub; the full namespace path for GitLab. */
  readonly project: string;
  readonly ref?: string;
  /** Set for self-managed GitLab. */
  readonly host?: string;
}

/**
 * Recognise a repository from a URL or shorthand. GitLab projects can nest
 * several groups deep (`group/subgroup/project`), which GitHub never does.
 */
export function parseTarget(input: string): ForgeTarget | null {
  const raw = input.trim();
  if (raw === '') return null;

  const url = /^https?:\/\/([^/]+)\/(.+)$/.exec(raw);
  if (url) {
    const host = url[1]!.toLowerCase();
    let path = url[2]!.replace(/[?#].*$/, '').replace(/\/$/, '');

    if (host === 'github.com' || host === 'www.github.com') {
      const tree = /^(.+?)\/tree\/(.+)$/.exec(path);
      const ref = tree?.[2];
      const project = (tree?.[1] ?? path).split('/').slice(0, 2).join('/');
      if (!project.includes('/')) return null;
      return { forge: 'github', project, ...(ref ? { ref } : {}) };
    }

    // GitLab: strip the web-UI segments that are not part of the project path.
    const gl = /^(.+?)\/-\/(?:tree|blob|commits?)\/([^/]+)/.exec(path);
    const ref = gl?.[2];
    if (gl) path = gl[1]!;
    path = path.replace(/\/-\/.*$/, '');
    if (!path.includes('/')) return null;
    return {
      forge: 'gitlab',
      project: path,
      ...(ref ? { ref } : {}),
      ...(host === 'gitlab.com' ? {} : { host }),
    };
  }

  // Shorthand: `owner/repo` is GitHub; `gitlab:group/sub/project` is GitLab.
  const prefixed = /^(github|gitlab):(.+)$/i.exec(raw);
  if (prefixed) {
    const forge = prefixed[1]!.toLowerCase() as 'github' | 'gitlab';
    const project = prefixed[2]!.replace(/\/$/, '');
    return project.includes('/') ? { forge, project } : null;
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(raw)) {
    return { forge: 'github', project: raw.replace(/\.git$/, '') };
  }
  // Deeper paths with no host are ambiguous; treat as GitLab, which allows them.
  if (/^[^/\s]+(\/[^/\s]+){2,}$/.test(raw)) return { forge: 'gitlab', project: raw };
  return null;
}
