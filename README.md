# Hermes CLI Status Line

A plugin for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop app. It adds a one-line live readout under the chat box, laid out like the status bar in Hermes's terminal version:

![status line](docs/status-line.png)

```
☤ gpt-6.1-sol │ 202K/500K │ [████░░░░░░] 40% │ ◎ 97.0% │ ↑ 15 t/s │ ⚡ ~42 t/s │ 🗜️ 1 │ ⚙ 2 │ ⛓ 1 │ 4h 5m │ Σ48.1M │ Claude 5h 14% wk 61% │ GPT wk 36%
```

Hover over any item for exact numbers and a short explanation.

| Item | Meaning |
|---|---|
| `☤ model` | The model answering in this chat. Each chat shows its own model. |
| `202K/500K` | Context used out of the model's context window. `~` means it's an estimate. |
| `[████░░░░░░] 40%` | How full the context is. Green below 50%, amber from 50%, red above 80%, bright red at 95%. |
| `◎ 97.0%` | Prompt-cache hit rate: how much of the input the provider re-used from its cache. |
| `↑ 15 t/s` | Average output speed for the session: output tokens ÷ time the model spent answering. Hermes keeps timing for only its last 10 calls, so the plugin saves it in blocks of 10 (it updates every 10 calls). The hover card shows how many calls are covered, plus Hermes's own last-10-call figure. |
| `⚡ ~42 t/s` | Output speed right now: text streaming into the chat over the last 5 seconds (estimated at ~4 characters per token). When streaming stops, the last stretch stays shown, dimmed (`⚡ ~40 t/s last`). Tool calls and reading files or images aren't streamed, so they don't move it. |
| `🗜️ 1` | How many times Hermes has compressed older turns to free up context. |
| `⚙ 2` | Background terminal commands this chat started (servers, builds, watchers) that are still running. Hover to see them. Appears only while one is running. |
| `⛓ 1` | Subagents (helpers) this chat started that are still running. Hermes reports a subagent's tokens only when it finishes, so the hover card then shows its speed: output tokens ÷ its whole run time, including time spent running tools. Shown while any run and for 5 minutes after. |
| `4h 5m` | Session duration. |
| `Σ48.1M` | Total tokens for the session (input + output). |
| `Claude 5h … wk …` | Claude subscription limits: % of the 5-hour and weekly allowances used, with reset times on hover. Only reported windows appear. |
| `GPT wk …` | ChatGPT/Codex subscription limits, shown the same way. Weekly-only accounts show no five-hour placeholder. |

The limit items appear only for providers you're signed into through a subscription login (OAuth): Anthropic (`anthropic`) and ChatGPT/Codex (`openai-codex`). They update every 2 minutes, whether or not a provider is present. If the first check after the app opens finds no data yet, one extra check runs 20 seconds later; otherwise there are no faster checks, and switching windows or reconnecting doesn't trigger extra ones.

**Click either limit item to switch between % used and % left.** Your choice is remembered. The two views use different colours:

- **Used** (default): green below 50%, amber from 50%, red above 80%, bright red at 95%, the same as the context meter.
- **Left** (`88% left`): the theme's accent colour while plenty remains, amber below 50% left, red below 20%, bright red at 5% or less.

The hover card always shows both numbers. Windows with unfamiliar names are shown under their own names rather than guessed as 5-hour or weekly. Model-specific allowances (such as Claude's Opus-only week) appear in the hover card only.

The line shortens to fit the width of the chat box. Below 76 characters it uses `·` separators and only the context percentage. Below 52 characters it shows just the model and session time. These are the same cut-offs the terminal status bar uses.

## Install

Clone the repo into your Hermes desktop plugins folder. The folder must be named `cli-status-line`:

```bash
# macOS / Linux
git clone https://github.com/Alex-Toronto/hermes-cli-status-line ~/.hermes/desktop-plugins/cli-status-line

# Windows (PowerShell)
git clone https://github.com/Alex-Toronto/hermes-cli-status-line "$env:LOCALAPPDATA\hermes\desktop-plugins\cli-status-line"
```

If you use a named Hermes profile, put it under that profile's folder instead: `<hermes home>/profiles/<name>/desktop-plugins/`.

The app loads it within a few seconds; no restart needed. If it doesn't appear, press Ctrl/⌘+K → **Reload desktop plugins**. To update, run `git pull` in that folder.

## Use

- **Show or hide:** Ctrl/⌘+K → **Toggle CLI status line**. This is the desktop equivalent of `/statusbar`, and your choice is remembered.
- **Turn it off completely:** Settings → Plugins.

## How it works

The plugin is one JavaScript file with no build step. It reads only what the Hermes desktop app already provides to plugins:

- context and token numbers for the chat you're in (`host.state.focusedUsage`)
- the model per chat (`session.status`)
- subscription limits from the app's model list (`model.options`), which uses Hermes's own cached limit data, so the line never makes the app wait
- the live speed from streamed text (`message.delta` / `reasoning.delta` events)
- background terminal commands for the chat you're in (`process.list`, checked every 15 seconds)

Number formats and colour thresholds are copied from the terminal's status bar (`hermes_cli/cli_status_bar_mixin.py`).

It uses no AI tokens and sends nothing anywhere. It stores two settings (on/off and used/left) and the saved speed blocks for your 50 most recent chats.

## Compatibility

Tested with Hermes desktop v0.21.6 (October 2026). The plugin relies on a few internal parts of the app, including the text of `session.status` and the shape of `model.options`. If a future Hermes update changes those, the affected item goes blank while the rest of the line keeps working.

## Tests

Run the dependency-free regression tests with Node.js:

```bash
node --test limits.test.cjs speed.test.cjs
```

These tests use made-up usage data and a minimal stand-in for the app to check polling, window selection, the used/left switch, labels, hover text, colours, the session-average blocks, the live and last-stretch speed, and subagent tracking. They don't replace checking it in the app.

## Credits

Subscription polling fixes, weekly-only window handling and the tests: [@audioclass](https://github.com/audioclass) ([#1](https://github.com/Alex-Toronto/hermes-cli-status-line/pull/1)).

## Licence

MIT. See [LICENSE](LICENSE).
