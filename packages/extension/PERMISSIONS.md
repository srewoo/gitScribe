# Permissions, and why each one exists

Reviewed for IMP-12. Anything not justified here should be removed.

## Granted at install

| Permission | Why | Verified |
|---|---|---|
| `storage` | Tokens, model choices, presets, and the theme. | — |
| `sidePanel` | The whole UI is a side panel. | — |
| `tabs` | To read the **URL of the active tab** so the panel can detect which repository you are looking at. | `activeTab` was tried first and is **not sufficient**: `chrome.tabs.query()` returns `url: null` under it, so detection silently fails. Measured, not assumed. |
| `https://api.github.com/*` | Repository metadata, trees, blobs, PRs, comparisons. | — |
| `https://codeload.github.com/*` | The tarball redirect target. Without it the redirect fails. | Confirmed in a service worker. |
| `https://gitlab.com/*` | GitLab projects, trees, archives. | — |

`tabs` grants the URL of every tab, which is more than this feature strictly
needs. It is the narrowest permission Chrome offers that makes tab detection
work. If you would rather not grant it, the panel still works — paste a
repository URL instead.

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
