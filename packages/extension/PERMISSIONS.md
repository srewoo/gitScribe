# Permissions, and why each one exists

Reviewed for IMP-12. Anything not justified here should be removed.

## Granted at install

| Permission | Why | Verified |
|---|---|---|
| `storage` | Tokens, model choices, presets, and the theme. | — |
| `sidePanel` | The whole UI is a side panel. | — |
| `https://github.com/*` | To read the **URL of a GitHub tab**, so the panel can detect which repository you are looking at. Chrome reveals a tab's URL only to extensions with access to that site, so this replaces the `tabs` permission. No content script runs there and nothing is fetched from it. | Measured in 0.3.0: without `tabs`, `chrome.tabs.query()` returns the URL of github.com and gitlab.com tabs and hides every other tab's URL (e.g. example.com). Detection of the active GitHub tab still works. |
| `https://api.github.com/*` | Repository metadata, trees, blobs, PRs, comparisons. | — |
| `https://codeload.github.com/*` | The tarball redirect target. Without it the redirect fails. | Confirmed in a service worker. |
| `https://gitlab.com/*` | GitLab projects, trees, archives. | — |

**`tabs` was removed in 0.3.0.** It exposed the URL of every tab (Chrome's
"Read your browsing history" warning). Tab detection now relies on the
GitHub/GitLab host permissions, so the extension sees the URLs of those tabs
only. A self-hosted GitLab tab is detected once you grant that host. Anywhere
else, paste a repository URL.

`activeTab` was tried before 0.3.0 and is not sufficient: `chrome.tabs.query()`
returns `url: null` under it, because the panel stays open while you browse.

Upgrading from 0.2.x: adding `https://github.com/*` is a new host, so Chrome
asks existing users to approve the update before re-enabling the extension.

## Requested only when you enable the feature

These are **not** granted at install. Chrome prompts when you save a key for
that provider, or set a self-hosted GitLab host.

| Origin | Requested when |
|---|---|
| `https://api.anthropic.com/*` | You save an Anthropic key |
| `https://generativelanguage.googleapis.com/*` | You save a Google key |
| `https://api.openai.com/*` | You save an OpenAI key |
| `https://api.x.ai/*` | You save an xAI key |
| `http://127.0.0.1/*` | You enable local Ollama |
| `https://<your-host>/*` | You set a self-hosted GitLab host |

A self-hosted GitLab host is requested as **that exact origin**, never as a
wildcard. Declining leaves the rest of the extension working: Ollama discovery
returns "no models" rather than an error, and providers you have not enabled
are simply unavailable.

## What is never done

- No forge token is attached to any URL other than that forge's own API.
- No credential is written into a saved artifact or an exported document.
- No content script is injected into any page.
