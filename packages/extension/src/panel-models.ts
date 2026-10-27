import { capacityFor, providerInfo, PROVIDERS, type ModelChoice, type ProviderId } from './llm.js';
import { EXACT_SUPPORT } from './counters.js';
import { requestProviderAccess } from './tokens.js';
import { invalidatePlan } from './panel-readme.js';
import { $, S, ollamaWindows } from './panel-state.js';

/** Two independent choices: bulk analysis, and the final synthesis. */
export async function renderModelPickers(): Promise<void> {
  const host = $('modelPickers');
  host.textContent = '';
  const { ollama } = { ollama: S.ollama };

  const row = (
    title: string,
    help: string,
    get: () => ModelChoice,
    set: (c: ModelChoice) => void,
  ): void => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:9px 0;border-bottom:1px solid var(--line)';

    const h = document.createElement('div');
    h.style.cssText = 'font-size:12px;font-weight:500;margin-bottom:3px';
    h.textContent = title;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:10.5px;color:var(--tx3);line-height:1.5;margin-bottom:7px';
    sub.textContent = help;
    wrap.append(h, sub);

    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:6px';

    const prov = document.createElement('select');
    prov.style.cssText =
      'height:28px;border:1px solid var(--line2);border-radius:4px;background:var(--panel);color:var(--tx);font:inherit;font-size:11.5px;padding:0 6px';
    for (const p of PROVIDERS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label;
      if (p.id === get().provider) o.selected = true;
      prov.append(o);
    }

    const modelBox = document.createElement('div');
    modelBox.className = 'fld';
    modelBox.style.flex = '1';
    const model = document.createElement('input');
    model.value = get().model;
    model.setAttribute('list', `models-${title.replace(/\W/g, '')}`);
    modelBox.append(model);

    const list = document.createElement('datalist');
    list.id = `models-${title.replace(/\W/g, '')}`;
    const fillList = (id: ProviderId): void => {
      list.textContent = '';
      const suggestions =
        id === 'ollama' ? ollama.map((m) => m.name) : [...providerInfo(id).models];
      for (const m of suggestions) {
        const o = document.createElement('option');
        o.value = m;
        list.append(o);
      }
    };
    fillList(get().provider);

    prov.addEventListener('change', () => {
      const id = prov.value as ProviderId;
      const first =
        id === 'ollama' ? (ollama[0]?.name ?? '') : (providerInfo(id).models[0] ?? '');
      model.value = first;
      fillList(id);
      set({ provider: id, model: first });
      invalidatePlan();
    });
    model.addEventListener('change', () => { set({ provider: prov.value as ProviderId, model: model.value.trim() }); invalidatePlan(); });

    // Only asked for when we have no verified or measured window for this model.
    const winRow = document.createElement('div');
    winRow.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:6px';
    const winLabel = document.createElement('label');
    winLabel.style.cssText = 'font-size:10.5px;color:var(--tx3);flex:1;line-height:1.4';
    winLabel.textContent = 'Context window unknown for this model. Enter it from the provider\u2019s docs:';
    const winBox = document.createElement('div');
    winBox.className = 'fld';
    winBox.style.width = '110px';
    const win = document.createElement('input');
    win.className = 'm';
    win.inputMode = 'numeric';
    win.placeholder = 'e.g. 128000';
    win.setAttribute('aria-label', `${title} context window in tokens`);
    winLabel.htmlFor = win.id = `win-${title.replace(/\W/g, '')}`;
    winBox.append(win);
    winRow.append(winLabel, winBox);
    const syncWin = (): void => {
      const c = get();
      const { source } = capacityFor({ provider: c.provider, model: c.model }, ollamaWindows());
      // Offer an override for approximate figures too, not just missing ones.
      winRow.classList.toggle('hide', source === 'vendor' || source === 'runtime');
      winLabel.textContent = source === 'secondary'
        ? 'Context window is approximate for this model. Override it from the provider\u2019s docs:'
        : 'Context window unknown for this model. Enter it from the provider\u2019s docs:';
      win.value = c.contextWindow ? String(c.contextWindow) : '';
    };
    win.addEventListener('change', () => {
      const n = Number(win.value.replace(/[,_\s]/g, ''));
      const { contextWindow: _, ...rest } = get();
      set(Number.isInteger(n) && n > 0 ? { ...rest, contextWindow: n } : rest);
      syncWin();
      invalidatePlan();
    });

    controls.append(prov, modelBox, list);
    wrap.append(controls, winRow);
    host.append(wrap);
    syncWin();
    prov.addEventListener('change', syncWin);
    model.addEventListener('change', syncWin);
  };

  row(
    'Analysis model',
    'Reads every chunk of code. This is the bulk of the cost — a cheap, fast model is usually right.',
    () => S.mapChoice,
    (c) => { S.mapChoice = c; void chrome.storage.local.set({ mapChoice: c }); },
  );
  row(
    'Synthesis model',
    'Writes the final README from the analysis notes. One call, and where quality shows.',
    () => S.reduceChoice,
    (c) => { S.reduceChoice = c; void chrome.storage.local.set({ reduceChoice: c }); },
  );
}

export function renderKeyFields(saved: Record<string, string>): void {
  const host = $('keyFields');
  host.textContent = '';

  for (const p of EXACT_SUPPORT) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'padding:9px 0;border-bottom:1px solid var(--line)';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:6px';
    const name = document.createElement('span');
    name.style.cssText = 'font-size:12px;font-weight:500';
    name.textContent = p.label;
    head.append(name);

    // What the key actually buys. Every provider here can generate a README;
    // only some can also count tokens exactly.
    const readme = document.createElement('span');
    readme.className = 'pill';
    readme.textContent = 'README';
    head.append(readme);
    if (p.exact) {
      const exact = document.createElement('span');
      exact.className = 'pill';
      exact.style.color = 'var(--ok)';
      exact.textContent = 'exact counts';
      head.append(exact);
    }
    wrap.append(head);

    // Every provider that needs a key gets a field. Previously OpenAI and xAI
    // had none, which left no way to use them for README generation at all.
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const fld = document.createElement('div');
    fld.className = 'fld';
    fld.style.flex = '1';
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder =
      p.provider === 'anthropic' ? 'sk-ant-…'
      : p.provider === 'google' ? 'AIza… (Google AI Studio)'
      : p.provider === 'openai' ? 'sk-…'
      : 'xai-…';
    input.value = saved[p.provider] ?? '';
    fld.append(input);

    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.style.height = '28px';
    btn.textContent = 'Save';
    btn.addEventListener('click', () => {
      const value = input.value.trim();
      // Host access is requested here, on the click, because that is the
      // moment the user actually enables this provider.
      void (async () => {
        if (value) {
          const granted = await requestProviderAccess(p.provider);
          if (!granted) {
            btn.textContent = 'Denied';
            setTimeout(() => (btn.textContent = 'Save'), 1600);
            return;
          }
        }
        const got = await chrome.storage.local.get('keys');
        const keys = { ...(got['keys'] as Record<string, string> | undefined) };
        if (value) keys[p.provider] = value;
        else delete keys[p.provider];
        await chrome.storage.local.set({ keys });
        btn.textContent = value ? 'Saved' : 'Removed';
        setTimeout(() => (btn.textContent = 'Save'), 1200);
      })();
    });
    row.append(fld, btn);
    wrap.append(row);

    const note = document.createElement('div');
    note.style.cssText = 'font-size:10.5px;color:var(--tx3);line-height:1.5;margin-top:6px';
    note.textContent = p.note;
    wrap.append(note);
    host.append(wrap);
  }

  // Ollama takes no key; say so rather than leaving a gap where a row should be.
  const local = document.createElement('div');
  local.style.cssText = 'padding:9px 0';
  const lh = document.createElement('div');
  lh.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:4px';
  const ln = document.createElement('span');
  ln.style.cssText = 'font-size:12px;font-weight:500';
  ln.textContent = 'Ollama';
  const lp = document.createElement('span');
  lp.className = 'pill';
  lp.textContent = 'no key needed';
  lh.append(ln, lp);
  const lnote = document.createElement('div');
  lnote.style.cssText = 'font-size:10.5px;color:var(--tx3);line-height:1.5';
  lnote.textContent =
    'Runs on your machine, so nothing is sent anywhere and nothing is charged. ' +
    'Context windows are read from the running server and are exact.';
  local.append(lh, lnote);
  host.append(local);
}
