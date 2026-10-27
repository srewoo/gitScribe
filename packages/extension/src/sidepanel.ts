/**
 * Side panel UI. Owns no network access — every fetch goes through the
 * background worker, which is the only CORS-exempt context.
 *
 * This file wires events and starts the panel; the panel-*.ts modules hold the rest.
 */
import { type Format } from '@gitscribe/core';
import { type ModelChoice } from './llm.js';
import { loadTokens } from './tokens.js';
import { loadChanges, refreshRate, runDiagnostics, runExactCount, updateExactHint } from './panel-extras.js';
import { loadOllama, renderForgeTokens } from './panel-forge.js';
import { load, parse, setGitlabHost, showEmpty, showPane } from './panel-load.js';
import { renderKeyFields, renderModelPickers } from './panel-models.js';
import { generate, refreshOutput, setFormat } from './panel-output.js';
import { loadPresets, presetKey, renderHistory, renderPresets } from './panel-presets.js';
import { hidePlan, prepareReadme, setReadmeStatus, startReadme } from './panel-readme.js';
import { $, S } from './panel-state.js';
import { addRuleFromInput, onScroll, renderTree } from './panel-tree.js';

function wire(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs .tab')) {
    b.addEventListener('click', () => showPane(b.dataset['tab']!));
  }
  $('settingsBtn').addEventListener('click', () => {
    const open = !$('settingsPane').classList.contains('hide');
    showPane(open ? 'files' : 'settings');
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('#formats button')) {
    b.addEventListener('click', () => setFormat(b.dataset['fmt'] as Format));
  }
  $('splitOn').addEventListener('change', () => { S.part = 1; refreshOutput(); });
  $('splitBudget').addEventListener('change', () => { S.part = 1; refreshOutput(); });
  $('partPrev').addEventListener('click', () => { if (S.part > 1) { S.part--; refreshOutput(); } });
  $('partNext').addEventListener('click', () => { if (S.part < S.parts) { S.part++; refreshOutput(); } });

  $('tree').addEventListener('scroll', onScroll, { passive: true });

  let filterTimer = 0;
  $('filter').addEventListener('input', (e) => {
    S.filter = (e.target as HTMLInputElement).value;
    // Rebuilding the tree over 26k paths per keystroke is wasteful; coalesce.
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      $('tree').scrollTop = 0;
      renderTree();
    }, 90) as unknown as number;
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
      e.preventDefault();
      $('filter').focus();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void generate();
  });

  $('genBtn').addEventListener('click', () => void generate());
  $('modeRepo').addEventListener('click', () => {
    $('modeRepo').classList.add('on'); $('modeChanges').classList.remove('on');
    $('tabs').classList.remove('hide');
    showPane('files');
  });
  $('modeChanges').addEventListener('click', () => {
    $('modeChanges').classList.add('on'); $('modeRepo').classList.remove('on');
    $('tabs').classList.add('hide');
    showPane('changes');
  });
  $('diffGo').addEventListener('click', () => void loadChanges());
  $('diffSpec').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void loadChanges();
  });
  $('diffCopy').addEventListener('click', () => {
    void navigator.clipboard.writeText(S.diffText).then(() => {
      $('diffCopy').textContent = 'Copied';
      setTimeout(() => ($('diffCopy').textContent = 'Copy'), 1200);
    });
  });
  $('diffSave').addEventListener('click', () => {
    const blob = new Blob([S.diffText], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${S.project.replace(/\//g, '-')}-changes.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('readmeBtn').addEventListener('click', () => void prepareReadme());
  $('readmeStart').addEventListener('click', () => void startReadme());
  $('readmeCancel').addEventListener('click', () => {
    hidePlan();
    setReadmeStatus('Cancelled. Nothing was sent.', '');
  });
  $('readmeCopy').addEventListener('click', () => {
    void navigator.clipboard.writeText(S.readmeText).then(() => {
      $('readmeCopy').textContent = 'Copied';
      setTimeout(() => ($('readmeCopy').textContent = 'Copy'), 1200);
    });
  });
  $('readmeSave').addEventListener('click', () => {
    const blob = new Blob([S.readmeText], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'README.md';
    a.click();
    URL.revokeObjectURL(a.href);
  });


  $('openBtn').addEventListener('click', () => {
    const v = ($('urlInput') as HTMLInputElement).value.trim();
    void parse(v).then((t) => {
      if (t) return load(t);
      showEmpty(
        'That does not look like a repository. Try a github.com or gitlab.com URL, ' +
          '"owner/repo", or "gitlab:group/subgroup/project".',
      );
      return undefined;
    });
  });

  $('copyBtn').addEventListener('click', () => {
    void navigator.clipboard.writeText(S.digestText).then(() => {
      $('copyBtn').textContent = 'Copied';
      setTimeout(() => ($('copyBtn').textContent = 'Copy'), 1200);
    });
  });

  $('saveBtn').addEventListener('click', () => {
    const ext = S.format === 'txt' ? 'txt' : S.format;
    const blob = new Blob([S.digestText], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const part = S.parts > 1 ? `-part${S.part}of${S.parts}` : '';
    a.download = `${S.project.replace(/\//g, '-')}-${S.commit.slice(0, 7)}${part}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('themeBtn').addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    void chrome.storage.local.set({ theme: next });
  });

  $('ollamaBtn').addEventListener('click', () => void loadOllama());

  $('diagBtn').addEventListener('click', () => void runDiagnostics());
  $('exactBtn').addEventListener('click', () => void runExactCount());

  $('ruleAddOk').addEventListener('click', addRuleFromInput);
  $('ruleInput').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') addRuleFromInput();
  });
  $('ruleModeEx').addEventListener('click', () => {
    S.ruleMode = 'exclude';
    $('ruleModeEx').classList.add('on'); $('ruleModeIn').classList.remove('on');
  });
  $('ruleModeIn').addEventListener('click', () => {
    S.ruleMode = 'include';
    $('ruleModeIn').classList.add('on'); $('ruleModeEx').classList.remove('on');
  });

  $('presetsBtn').addEventListener('click', () => {
    showPane('presets');
    void renderPresets(); void renderHistory();
  });
  // An inline field rather than prompt(): a modal dialog blocks the panel and
  // is a poor fit for a docked surface.
  $('presetSave').addEventListener('click', () => {
    $('presetNameRow').classList.toggle('hide');
    if (!$('presetNameRow').classList.contains('hide')) $('presetName').focus();
  });
  const commitPreset = (): void => {
    const input = $('presetName') as HTMLInputElement;
    const name = input.value.trim();
    if (!name || !S.project) return;
    void loadPresets().then((all) => {
      const next = [...all.filter((p) => p.name !== name), {
        name, rules: S.rules.map((r) => ({ ...r })), overrides: { ...S.overrides },
      }];
      return chrome.storage.local.set({ [presetKey()]: next });
    }).then(() => {
      input.value = '';
      $('presetNameRow').classList.add('hide');
      $('presetSave').textContent = 'Saved';
      setTimeout(() => ($('presetSave').textContent = 'Save preset'), 1200);
    });
  };
  $('presetNameOk').addEventListener('click', commitPreset);
  $('presetName').addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') commitPreset();
  });
}

/* -------------------------------------------------------------------- init */

async function init(): Promise<void> {
  // wire() touching one missing element used to throw and abort init entirely,
  // leaving a panel that said "No repository open" on a page it could read.
  const guard = async <T>(label: string, fn: () => T | Promise<T>): Promise<void> => {
    try { await fn(); } catch (e) { console.error(`GitScribe: ${label} failed`, e); }
  };
  void guard;
  const { theme, keys, mapChoice, reduceChoice } = await chrome.storage.local.get([
    'theme', 'keys', 'mapChoice', 'reduceChoice',
  ]);
  if (mapChoice) S.mapChoice = mapChoice as ModelChoice;
  if (reduceChoice) S.reduceChoice = reduceChoice as ModelChoice;
  renderKeyFields((keys as Record<string, string> | undefined) ?? {});
  void renderForgeTokens();
  void loadTokens().then((t) => setGitlabHost(t.gitlabHost));
  void renderModelPickers();
  document.documentElement.setAttribute('data-theme', typeof theme === 'string' ? theme : 'light');

  await guard('wire', () => wire());
  await guard('exact hint', () => updateExactHint());
  void loadOllama();
  void refreshRate();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const target = tab?.url ? await parse(tab.url) : null;
  if (target) await load(target);
  else showEmpty('This tab is not a GitHub or GitLab repository. Paste a repository URL below.');
}

void init();
