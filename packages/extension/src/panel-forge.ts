import { loadTokens, requestGitlabHost, saveGitlabHost, saveToken, type ForgeId, type TokenCheck } from './tokens.js';
import { renderTotals } from './panel-budget.js';
import { renderModelPickers } from './panel-models.js';
import { $, S, send } from './panel-state.js';

export async function loadOllama(): Promise<void> {
  try {
    const { models } = await send<{ models: Array<{ name: string; contextWindow: number }> }>({ kind: 'ollama' });
    S.ollama = models;
    void renderModelPickers();
    $('ollamaMsg').textContent = models.length
      ? `${models.length} local model(s) found at 127.0.0.1:11434`
      : 'Ollama not running — local models hidden';
    renderTotals();
  } catch {
    $('ollamaMsg').textContent = 'Could not reach Ollama.';
  }
}

export const FORGES: ReadonlyArray<{
  id: ForgeId; label: string; placeholder: string; help: string; scope: string;
}> = [
  {
    id: 'github',
    label: 'GitHub',
    placeholder: 'github_pat_… or ghp_…',
    scope: 'Contents: read',
    help: 'Anonymous allows 60 requests an hour, shared by everyone on your IP address.',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    placeholder: 'glpat-…',
    scope: 'read_api',
    help:
      'GitLab throttles anonymous archive downloads aggressively (it answers 406), ' +
      'so a token matters more here than on GitHub.',
  },
];

export function statusNote(check: TokenCheck): HTMLElement {
  const note = document.createElement('div');
  note.className = 'note ' + (check.valid ? 'o' : 'd');
  note.style.marginTop = '8px';
  const b = document.createElement('b');
  b.textContent = check.valid ? 'Token works' : 'Token rejected';
  note.append(b, document.createElement('br'), document.createTextNode(check.message));
  if (check.scopes) {
    note.append(document.createElement('br'), document.createTextNode(`Scopes: ${check.scopes}`));
  }
  return note;
}

export async function renderForgeTokens(): Promise<void> {
  const host = $('forgeTokens');
  host.textContent = '';
  const stored = await loadTokens();

  for (const f of FORGES) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:10px 0;border-bottom:1px solid var(--line)';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:6px';
    const name = document.createElement('span');
    name.style.cssText = 'font-size:12px;font-weight:500';
    name.textContent = f.label;
    const tag = document.createElement('span');
    tag.className = 'pill';
    tag.textContent = stored[f.id] ? 'token saved' : 'anonymous';
    head.append(name, tag);
    wrap.append(head);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const fld = document.createElement('div');
    fld.className = 'fld';
    fld.style.flex = '1';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = f.placeholder;
    input.value = stored[f.id] ?? '';
    fld.append(input);

    const test = document.createElement('button');
    test.className = 'btn';
    test.style.height = '28px';
    test.textContent = 'Test';

    const save = document.createElement('button');
    save.className = 'btn';
    save.style.height = '28px';
    save.textContent = 'Save';

    row.append(fld, test, save);
    wrap.append(row);

    const out = document.createElement('div');
    wrap.append(out);

    test.addEventListener('click', () => {
      out.textContent = '';
      test.disabled = true;
      test.textContent = '…';
      void send<TokenCheck>({
        kind: 'checkToken', forge: f.id, token: input.value,
        ...(f.id === 'gitlab' && stored.gitlabHost ? { host: stored.gitlabHost } : {}),
      })
        .then((check) => out.append(statusNote(check)))
        .catch((e: unknown) => {
          const n = document.createElement('div');
          n.className = 'note d';
          n.style.marginTop = '8px';
          n.textContent = e instanceof Error ? e.message : String(e);
          out.append(n);
        })
        .finally(() => { test.disabled = false; test.textContent = 'Test'; });
    });

    save.addEventListener('click', () => {
      void saveToken(f.id, input.value.trim()).then(() => {
        save.textContent = 'Saved';
        tag.textContent = input.value.trim() ? 'token saved' : 'anonymous';
        setTimeout(() => (save.textContent = 'Save'), 1200);
      });
    });

    const help = document.createElement('div');
    help.style.cssText = 'font-size:10.5px;color:var(--tx3);line-height:1.5;margin-top:7px';
    help.textContent = `Needs ${f.scope}. ${f.help}`;
    wrap.append(help);

    if (f.id === 'gitlab') {
      const hostRow = document.createElement('div');
      hostRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:7px';
      const hf = document.createElement('div');
      hf.className = 'fld';
      hf.style.flex = '1';
      const hi = document.createElement('input');
      hi.placeholder = 'gitlab.com (or your self-managed host)';
      hi.value = stored.gitlabHost ?? '';
      hf.append(hi);
      const hb = document.createElement('button');
      hb.className = 'btn';
      hb.style.height = '28px';
      hb.textContent = 'Set host';
      hb.addEventListener('click', () => {
        const host = hi.value.trim();
        void (async () => {
          // Bind to the single origin the user typed; never widen to https://*/*.
          const granted = await requestGitlabHost(host);
          if (!granted) {
            hb.textContent = 'Denied';
            setTimeout(() => (hb.textContent = 'Set host'), 1600);
            return;
          }
          await saveGitlabHost(host);
          hb.textContent = 'Set';
          setTimeout(() => (hb.textContent = 'Set host'), 1200);
        })();
      });
      hostRow.append(hf, hb);
      wrap.append(hostRow);
    }

    host.append(wrap);
  }
}
