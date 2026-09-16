/**
 * Secret redaction.
 *
 * A digest is pasted into a chat box, so anything it carries leaves the
 * machine. Committed credentials are common, and the cost of missing one is
 * far higher than the cost of a false positive — so patterns here are
 * high-precision but we redact by default and always report what was hit.
 *
 * This is a safety net, not a secret scanner. It does not replace gitleaks.
 */

export interface RedactionRule {
  readonly kind: string;
  readonly pattern: RegExp;
}

/** Each pattern is anchored on a vendor-documented prefix or structure. */
export const RULES: readonly RedactionRule[] = [
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { kind: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'openai-api-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'slack-token', pattern: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },
  { kind: 'stripe-live-key', pattern: /\b[sr]k_live_[0-9A-Za-z]{16,}\b/g },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: 'private-key-block',
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
  },
];

/**
 * Assignments inside dotenv-style files. Applied only to files whose name
 * looks like an env file, because `KEY=value` is far too common elsewhere.
 */
// Horizontal whitespace only: \s would swallow the newline and capture the
// NEXT line as this key's value, silently eating a line of the file.
const ENV_ASSIGNMENT =
  /^([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS|API|DSN|URI|URL))[ \t]*=[ \t]*(.+)$/gm;

const ENV_FILE = /(^|\/)\.env(\.|$)|(^|\/)\.?env\.[A-Za-z0-9_-]+$/;

/** A placeholder that is obviously a placeholder, and names what it replaced. */
function placeholder(kind: string): string {
  return `[GITSCRIBE-REDACTED:${kind}]`;
}

export interface RedactionHit {
  readonly kind: string;
  readonly count: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly hits: readonly RedactionHit[];
}

export function isEnvFile(path: string): boolean {
  return ENV_FILE.test(path);
}

/**
 * Redact secrets from one file's text. Returns the text unchanged and an
 * empty hit list when nothing matched, so callers can skip cheaply.
 */
export function redactSecrets(path: string, text: string): RedactionResult {
  const counts = new Map<string, number>();
  let out = text;

  for (const { kind, pattern } of RULES) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, () => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return placeholder(kind);
    });
  }

  if (isEnvFile(path)) {
    ENV_ASSIGNMENT.lastIndex = 0;
    out = out.replace(ENV_ASSIGNMENT, (_m, key: string, value: string) => {
      const trimmed = value.trim();
      // Leave empty values and obvious placeholders alone — they carry meaning.
      if (trimmed === '' || /^(""|''|<.*>|your[-_]|xxx+|changeme|todo)/i.test(trimmed)) {
        return `${key}=${value}`;
      }
      counts.set('env-assignment', (counts.get('env-assignment') ?? 0) + 1);
      return `${key}=${placeholder('env-assignment')}`;
    });
  }

  const hits = [...counts].map(([kind, count]) => ({ kind, count }));
  return { text: out, hits };
}
