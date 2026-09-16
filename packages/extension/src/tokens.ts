/**
 * Token storage and validation.
 *
 * A saved token is not a working token. The panel previously claimed
 * "Authenticated" the moment a string was stored, which is how a 401 ends up
 * on screen next to a green success note. Nothing here reports authenticated
 * status without a round trip that proves it.
 */

export type ForgeId = 'github' | 'gitlab';

export interface TokenCheck {
  readonly valid: boolean;
  /** Account the token belongs to, when it is valid. */
  readonly user?: string;
  /** Scopes GitHub reports; GitLab reports them on its own endpoint. */
  readonly scopes?: string;
  readonly rate?: { limit: number; remaining: number };
  readonly message: string;
}

export interface StoredTokens {
  github?: string;
  gitlab?: string;
  /** Self-managed GitLab host, if any. */
  gitlabHost?: string;
}

export async function loadTokens(): Promise<StoredTokens> {
  const got = await chrome.storage.local.get(['tokens', 'pat']);
  const tokens = { ...(got['tokens'] as StoredTokens | undefined) };
  // Migrate the original single-token field.
  if (!tokens.github && typeof got['pat'] === 'string' && got['pat']) {
    tokens.github = got['pat'];
    await chrome.storage.local.set({ tokens });
    await chrome.storage.local.remove('pat');
  }
  return tokens;
}

export async function saveToken(forge: ForgeId, value: string): Promise<void> {
  const tokens = await loadTokens();
  if (value) tokens[forge] = value;
  else delete tokens[forge];
  await chrome.storage.local.set({ tokens });
}

export async function saveGitlabHost(host: string): Promise<void> {
  const tokens = await loadTokens();
  if (host) tokens.gitlabHost = host;
  else delete tokens.gitlabHost;
  await chrome.storage.local.set({ tokens });
}

/** Verify a GitHub token by asking who it belongs to. */
async function checkGitHub(token: string): Promise<TokenCheck> {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
    },
  });
  const limit = Number(res.headers.get('x-ratelimit-limit') ?? '0');
  const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '0');

  if (res.status === 401) {
    return { valid: false, message: 'Rejected (401). The token is wrong, revoked, or expired.' };
  }
  if (res.status === 403) {
    return { valid: false, message: 'Forbidden (403). The token exists but is not permitted to read your account.' };
  }
  if (!res.ok) {
    return { valid: false, message: `GitHub responded ${res.status}.` };
  }
  const body = (await res.json()) as { login?: string };
  const scopes = res.headers.get('x-oauth-scopes');
  return {
    valid: true,
    ...(body.login ? { user: body.login } : {}),
    // Fine-grained tokens report no scopes header at all; that is expected.
    ...(scopes ? { scopes } : {}),
    rate: { limit, remaining },
    message: `Valid${body.login ? ` — ${body.login}` : ''}. ${remaining}/${limit} requests left this hour.`,
  };
}

/** Verify a GitLab token the same way, against its own API. */
async function checkGitLab(token: string, host = 'gitlab.com'): Promise<TokenCheck> {
  const res = await fetch(`https://${host}/api/v4/user`, {
    headers: { 'PRIVATE-TOKEN': token },
  });
  if (res.status === 401) {
    return { valid: false, message: 'Rejected (401). The token is wrong, revoked, or expired.' };
  }
  if (res.status === 403) {
    return { valid: false, message: 'Forbidden (403). The token lacks the read_api scope.' };
  }
  if (!res.ok) return { valid: false, message: `GitLab responded ${res.status}.` };

  const body = (await res.json()) as { username?: string };
  const limit = Number(res.headers.get('ratelimit-limit') ?? '0');
  const remaining = Number(res.headers.get('ratelimit-remaining') ?? '0');
  return {
    valid: true,
    ...(body.username ? { user: body.username } : {}),
    ...(limit ? { rate: { limit, remaining } } : {}),
    message: `Valid${body.username ? ` — ${body.username}` : ''}.${
      limit ? ` ${remaining}/${limit} requests left this minute.` : ''
    }`,
  };
}

export async function checkToken(
  forge: ForgeId,
  token: string,
  host?: string,
): Promise<TokenCheck> {
  if (!token.trim()) return { valid: false, message: 'No token entered.' };
  try {
    return forge === 'github'
      ? await checkGitHub(token.trim())
      : await checkGitLab(token.trim(), host);
  } catch (e) {
    return {
      valid: false,
      message: `Could not reach ${forge === 'github' ? 'GitHub' : 'GitLab'}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

/* ------------------------------------------- IMP-12: optional permissions */

/** Origins a provider needs, requested only when that provider is enabled. */
const PROVIDER_ORIGINS: Readonly<Record<string, string>> = {
  anthropic: 'https://api.anthropic.com/*',
  google: 'https://generativelanguage.googleapis.com/*',
  openai: 'https://api.openai.com/*',
  xai: 'https://api.x.ai/*',
  ollama: 'http://127.0.0.1/*',
};

export function originFor(provider: string): string | undefined {
  return PROVIDER_ORIGINS[provider];
}

export async function hasProviderAccess(provider: string): Promise<boolean> {
  const origin = PROVIDER_ORIGINS[provider];
  if (!origin) return true;
  return chrome.permissions.contains({ origins: [origin] });
}

/**
 * Ask for a provider's host access at the moment it is enabled, rather than
 * holding it from installation. Must be called from a user gesture.
 */
export async function requestProviderAccess(provider: string): Promise<boolean> {
  const origin = PROVIDER_ORIGINS[provider];
  if (!origin) return true;
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

/** Self-hosted GitLab: bind access to the one origin the user configured. */
export async function requestGitlabHost(host: string): Promise<boolean> {
  if (!host || host === 'gitlab.com') return true;
  if (!/^[a-z0-9.-]+$/i.test(host)) return false;   // never widen to a pattern
  try {
    return await chrome.permissions.request({ origins: [`https://${host}/*`] });
  } catch {
    return false;
  }
}
