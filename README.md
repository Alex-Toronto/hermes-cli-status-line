# Hermes CLI Status Line

A plugin for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop app. It adds a one-line live readout under the chat box, laid out like the status bar in Hermes's terminal version:

![status line](docs/status-line.png)

```
☤ gpt-6.1-sol │ 202K/500K │ [████░░░░░░] 40% │ ◎ 97.0% │ ↑ 15 t/s │ ⚡ ~42 t/s │ 🗜️ 1 │ 4h 5m │ Σ48.1M │ Claude 5h 14% wk 61% │ GPT 5h 39% wk 36%
```

Hover over any item for exact numbers and a short explanation.

| Item | Meaning |
|---|---|
| `☤ model` | The model answering in this chat. Each chat shows its own model. |
| `202K/500K` | Context used out of the model's context window. `~` means it's an estimate. |
| `[████░░░░░░] 40%` | How full the context is. Green below 50%, amber from 50%, red above 80%, bright red at 95%. |
| `◎ 97.0%` | Prompt-cache hit rate: how much of the input the provider re-used from its cache. |
| `↑ 15 t/s` | Average output speed over the last ~10 model calls. |
| `⚡ ~42 t/s` | Output speed right now: text streaming into the chat over the last 3 seconds (estimated at ~4 characters per token). Shows `–` while idle or while tools run. |
| `🗜️ 1` | How many times Hermes has compressed older turns to free up context. |
| `4h 5m` | Session duration. |
| `Σ48.1M` | Total tokens for the session (input + output). |
| `Claude 5h … wk …` | Claude subscription limits: % of the 5-hour and weekly allowances used, with reset times on hover. |
| `GPT 5h … wk …` | ChatGPT/Codex subscription limits, shown the same way. |

The limit items appear only for providers you're signed into through a subscription login (OAuth): Anthropic (`anthropic`) and ChatGPT/Codex (`openai-codex`). They update about every 2 minutes.

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

Number formats and colour thresholds are copied from the terminal's status bar (`hermes_cli/cli_status_bar_mixin.py`).

It sends nothing anywhere and stores only its on/off setting.

## Compatibility

Tested with Hermes desktop v0.21.6 (October 2026). The plugin relies on a few internal parts of the app, including the text of `session.status` and the shape of `model.options`. If a future Hermes update changes those, the affected item goes blank while the rest of the line keeps working.

## Licence

MIT. See [LICENSE](LICENSE).
