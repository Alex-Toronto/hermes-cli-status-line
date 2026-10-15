# Hermes CLI Status Line

[![tests](https://github.com/Alex-Toronto/hermes-cli-status-line/actions/workflows/tests.yml/badge.svg)](https://github.com/Alex-Toronto/hermes-cli-status-line/actions/workflows/tests.yml)

A plugin for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop app. It adds a one-line live readout under the chat box, laid out like the status bar in Hermes's terminal version:

![status line](docs/status-line.png)

```
☤ gpt-6.1-sol │ 202K/500K │ [████░░░░░░] 40% │ ◎ 97.0% │ ↑ 15 t/s │ ⚡ ~42 t/s │ 🗜️ 1 │ ⚙ 2 │ ⛓ 1 │ 4h 5m │ Σ48.1M │ Claude 5h 14% wk 61% │ GPT wk 36%
```

It is a lightweight visual aid: it only reads and shows what Hermes already knows. It **saves nothing**, uses **no AI tokens**, and **sends nothing anywhere**.

Hover over any item for exact numbers and a short explanation.

| Item | Meaning |
|---|---|
| `☤ model` | The model answering in this chat. Each chat shows its own model. |
| `202K/500K │ [████░░░░░░] 40%` | Context window: tokens used out of the model's window, and how full it is. Green below 50%, amber from 50%, red above 80%, bright red at 95%. `~` means it's an estimate. **Click to cycle** numbers and meter → meter only → numbers only. |
| `◎ 97.0%` | Prompt-cache hit rate: how much of the input the provider re-used from its cache. |
| `↑ 15 t/s` | Average output speed over the last 10 model calls: output tokens ÷ time the model spent answering. Hermes keeps timing for only those 10 calls. |
| `⚡ ~42 t/s` | Output speed right now: text streaming into the chat over the last 5 seconds (estimated at ~4 characters per token). When streaming stops, the last stretch stays shown, dimmed (`⚡ ~40 t/s last`). Tool calls and reading files or images aren't streamed, so they don't move it. |
| `🗜️ 1` | How many times Hermes has compressed older turns to free up context. |
| `⚙ 2` | Background terminal commands this chat started (servers, builds, watchers) that are still running. Hover to see them, with anything that looks like a key, token or password hidden. |
| `⛓ 1` | Subagents (helpers) this chat has running, as Hermes lists them. Hermes reports a subagent's tokens only when it finishes, so the hover card then shows its speed: output tokens ÷ its whole run time, including time spent running tools. Shown while any run and for 5 minutes after. |
| `4h 5m` | Session duration (clock time since the chat started, including idle time). Works for bot chats too. |
| `Σ48.1M` | Total tokens for the session (input + output). |
| `Claude 5h … wk …` | Claude subscription limits: % of the 5-hour and weekly allowances used, with reset times on hover. Only reported windows appear. |
| `GPT wk …` | ChatGPT/Codex subscription limits, shown the same way. Weekly-only accounts show no five-hour placeholder. |
| `OpenRouter quota …` and others | Any other signed-in provider whose limits Hermes can read, shown the same way. |

A limit item appears for every signed-in provider that Hermes can read limits for. With Hermes v0.22.0 that is:

- **Claude** (`anthropic`, subscription login) — 5-hour and weekly allowances; Opus/Sonnet-only weeks in the hover card.
- **GPT** (`openai-codex`, ChatGPT login) — 5-hour and weekly allowances.
- **OpenRouter** (`openrouter`) — the API key's spending limit, only if the key has one set.
- **Zen** (`opencode-zen`) and any provider plugin that reports usage to Hermes.

Providers Hermes can't read limits for (plain API keys for Anthropic, OpenAI, Gemini and most others) don't appear. Nous Portal credits aren't shown: Hermes reports them through a live account request on every check, which this plugin avoids.

The limits are checked every 5 minutes, from data Hermes already keeps; Hermes itself decides when to ask each provider, at most every 2 minutes per provider. If the first check after the app opens finds nothing, one extra check runs 20 seconds later. There are no faster checks and no retry loops, and switching windows or reconnecting doesn't add any.

**Click either limit item to switch between % used and % left.** The two views use different colours:

- **Used** (default): green below 50%, amber from 50%, red above 80%, bright red at 95%, the same as the context meter.
- **Left** (`88% left`): the theme's accent colour while plenty remains, amber below 50% left, red below 20%, bright red at 5% or less.

The hover card always shows both numbers. Model-specific allowances (such as Claude's Opus-only week) appear in the hover card only.

The line shortens to fit the width of the chat box. Below 76 characters it uses `·` separators and only the context percentage. Below 52 characters it shows just the model and session time. These are the same cut-offs the terminal status bar uses.

**Split view:** Hermes gives plugins numbers only for the chat you're focused on, so with several chats side by side the line shows only under the focused one, starting with that chat's name (`▸ Sivilla Lead │ …`). Click a chat to move the line there.

## Install

Install a numbered release rather than the latest `main`, so you get a version that has been reviewed and tested. Replace `v1.1.1` with the [latest release](https://github.com/Alex-Toronto/hermes-cli-status-line/releases). The folder must be named `cli-status-line`:

```bash
# macOS / Linux
git clone --branch v1.1.1 https://github.com/Alex-Toronto/hermes-cli-status-line ~/.hermes/desktop-plugins/cli-status-line

# Windows (PowerShell)
git clone --branch v1.1.1 https://github.com/Alex-Toronto/hermes-cli-status-line "$env:LOCALAPPDATA\hermes\desktop-plugins\cli-status-line"
```

If you use a named Hermes profile, put it under that profile's folder instead: `<hermes home>/profiles/<name>/desktop-plugins/`.

The app loads it within a few seconds; no restart needed. If it doesn't appear, press Ctrl/⌘+K → **Reload desktop plugins**.

To update to a newer release, read its release notes, then in that folder run `git fetch --tags` and `git checkout <new tag>`.

## Use

- **Show or hide:** Ctrl/⌘+K → **Toggle CLI status line** (the desktop equivalent of `/statusbar`).
- **Turn it off completely:** Settings → Plugins.

Because nothing is saved, each time the app starts the line is shown, the context item shows numbers and meter, and limits are in the "used" view.

## How it works

The plugin is one JavaScript file with no build step and no dependencies. It reads only what the Hermes desktop app already provides to plugins, through read-only requests:

| Data | Source | How often |
|---|---|---|
| Context and token numbers | `host.state.focusedUsage` (pushed by the app) | live |
| Model per chat | `session.status` | on model switch, and every 5 min |
| Chat start time | `session.list` | once per chat |
| Subscription limits | `model.options` (Hermes's own cached limit data) | every 2 min |
| Background commands | `process.list` | every 15 s |
| Running subagents | `subagent.list` | when one starts or finishes; every 20 s while any run |
| Live speed, finished subagents | `message.delta`, `reasoning.delta`, `subagent.*` events the app already receives | live |

The live speed and finished-subagent figures are held in memory only (capped at 20 chats) and disappear when the app closes. Number formats and colour thresholds are copied from the terminal's status bar (`hermes_cli/cli_status_bar_mixin.py`).

## Privacy and security

- **Saves nothing.** The plugin writes no files and no app storage. Versions before v1.0.0 saved three small settings; on load the plugin removes those leftovers if they exist (on a fresh install there is nothing to remove).
- **No network access of its own.** It makes no web requests and loads no code. The limit numbers come from Hermes, which checks your providers' account-status endpoints itself.
- **Read-only.** It only asks Hermes for information and never changes chats, settings or processes.
- **Safe display.** All text is shown as plain text, so a model reply or subagent goal can't inject anything into the app. Anything in background-command lines or subagent goals that looks like a key, token or password is hidden as `••••`. This is a best-effort pattern match, not a guarantee, so avoid typing secrets into commands.

See [SECURITY.md](SECURITY.md) for how to report a problem.

## Compatibility

Built and tested on **Hermes Agent v0.22.0** (`v0.22.0+167.ge8c8e46`, October 2026) with the desktop app on Windows 11.

The plugin relies on a few internal parts of the app: the text of `session.status`, the shape of `model.options`, `process.list` and `subagent.list`, the chat panes' `data-session-anchor` attribute, and the streamed-text events. A Hermes update can change any of these. If one changes, only the matching item goes blank or wrong while the rest of the line keeps working. **After updating Hermes, glance at the line**, and report anything that looks off.

### Not yet tested

- **Light theme — not tested.** Only the dark theme has been checked on screen. All colours come from the app's theme except the amber warning colour, a fixed amber blended toward the theme's text colour, which should read well on light themes. If anything is hard to read in light mode, please open an issue with a screenshot.
- **macOS and Linux.** Only Windows 11 has been tested. The emoji fallback fonts listed cover all three systems.
- **Other Hermes versions** than v0.22.0.
- **Providers other than Claude and ChatGPT** on a real account: OpenRouter key limits, Zen and plugin providers are covered by the tests with made-up data only.
- **Remote gateways** (the desktop app connected to Hermes on another machine) and **multiple accounts for one provider** (the first account that reports limits is shown).
- **Screen readers.** The limit items can be clicked and used with the keyboard, but the line hasn't been checked with assistive software.

## Tests

Run the dependency-free tests with Node.js:

```bash
node --test limits.test.cjs speed.test.cjs
```

They use made-up data and a minimal stand-in for the app to check polling, window selection, the used/left switch, labels, colours, the live and last-stretch speed, subagent tracking, the memory caps, secret hiding, and that the plugin saves nothing and makes no network requests of its own. They don't replace checking it in the app.

They run automatically on GitHub for every pull request and every change to `main`, and must pass before anything merges. Dependabot checks weekly for updates to the pinned GitHub Actions and opens a pull request when one is out.

## Credits

Subscription polling fixes, weekly-only window handling and the first tests: [@audioclass](https://github.com/audioclass) ([#1](https://github.com/Alex-Toronto/hermes-cli-status-line/pull/1)).

## Licence

MIT. See [LICENSE](LICENSE).
