# Hermes CLI Status Line

[![tests](https://github.com/Alex-Toronto/hermes-cli-status-line/actions/workflows/tests.yml/badge.svg)](https://github.com/Alex-Toronto/hermes-cli-status-line/actions/workflows/tests.yml)

A one-line readout below the [Hermes Agent](https://github.com/NousResearch/hermes-agent) desktop chat box, styled after its terminal status bar.

![status line](docs/status-line.png)

```text
☤ gpt-6.1-sol │ 202K/500K │ [████░░░░░░] 40% │ ◎ 97.0% │ ↑ 15 t/s │ ⚡ ~42 t/s │ 🗜️ 1 │ ⚙ 2 │ ⛓ 1 │ 4h 5m │ Σ48.1M │ Claude 5h 14% wk 61% │ GPT wk 36%
```

It displays Hermes-owned data without model calls or additions to chat context. There are no direct network calls or persistent tracking, but local Hermes RPCs can trigger backend work, including provider account-status refreshes. These properties do **not** establish low overhead or zero tab-switch latency.

## Read the line

Hover over an item for details. Items depend on available data.

| Item | Meaning |
|---|---|
| `☤ model` | Focused chat's model; app default is a fallback until session-specific data arrives. |
| Context | Used/window and fullness; `~` means estimated. Click to cycle **numbers + meter → meter only → numbers only**. Meter-only has no percentage text. |
| `◎ 97.0%` | Provider-reported prompt-cache hit rate. |
| `↑ 15 t/s` | Hermes's rolling output speed over up to the last 10 model calls, not a whole-session average. |
| `⚡ ~42 t/s` | Answer/visible-reasoning text over 5 seconds, estimated at 4 characters/token. Last stretch remains dimmed with `last`; tool execution and file/image reads do not contribute streamed text. |
| `🗜️ 1` | Context compressions this session. |
| `⚙ 2` | Running background terminal jobs; command previews use best-effort secret redaction. |
| `⛓ 1` | Running subagents. Completions appear in the hover card for 5 minutes; output tokens/run time includes tool time. |
| `4h 5m` | Wall-clock duration including idle time, if start time is found. |
| `Σ48.1M` | Session input + output tokens summed across calls, including cached input. |
| Provider limits | Reported allowances and reset times. Weekly-only accounts have no five-hour placeholder; model-specific windows stay in the hover card. |

Context and **% used** colours: green below 50%, amber 50–80%, red above 80%, bright red at 95% or more. Click any provider item to switch all limits between **% used** and **% left**. Left uses theme accent at 50% or more, amber below 50%, red below 20%, bright red at 5% or less. Hover shows both values. Context and limit controls also work with **Tab, then Enter or Space**. Modes are shared across panes and reset on registration/app restart.

Any authenticated provider with reported usage windows can appear: Claude and GPT first, then OpenRouter key quotas, Zen or other provider plugins as available. With pooled accounts, the first account with windows is used. Nous Portal credits are not queried through `session.usage`.

### Width and split view

Width is estimated in monospace columns from the **container**, not the window:

- **76+ columns:** full line, `│` separators; default context shows numbers, meter and percentage.
- **52–75:** `·` separators; default context is percentage only. Explicit meter-only/numbers-only modes retain those forms. Average/live speed and session-token total are omitted.
- **Below 52:** model and available duration only, plus the split-view active-chat prefix.

With several visible chats, the line belongs to the focused pane. Its `▸` prefix uses the pane's visible tab name (including bot names), falling back to stored title, then `This chat`; long names are shortened. Background tabs are excluded using Hermes's `data-pane-hidden` marker, not dialog-related `aria-hidden`/`inert` attributes.

## Install and use

Install **v1.2.1**, the numbered maintenance release described here. See [CHANGELOG.md](CHANGELOG.md) and [release notes](https://github.com/Alex-Toronto/hermes-cli-status-line/releases) for changes. The folder must be named `cli-status-line`.

```bash
# macOS / Linux
git clone --branch v1.2.1 https://github.com/Alex-Toronto/hermes-cli-status-line ~/.hermes/desktop-plugins/cli-status-line
```

```powershell
# Windows
git clone --branch v1.2.1 https://github.com/Alex-Toronto/hermes-cli-status-line "$env:LOCALAPPDATA\hermes\desktop-plugins\cli-status-line"
```

For a named profile, use `<hermes home>/profiles/<name>/desktop-plugins/cli-status-line`. The app normally loads it within seconds without restarting; fallback: Ctrl/⌘+K → **Reload desktop plugins**.

- **Show/hide:** Ctrl/⌘+K → **Toggle CLI status line**. This does not shut down all plugin activity.
- **Disable:** Settings → Plugins.
- **Update:** read release notes, then `git fetch --tags` and `git checkout <new tag>` in the plugin folder. Prefer numbered releases to the development branch.

## Data and scheduling

One JavaScript module, no build step; React and the SDK come from Hermes. Session queries are cached by session identity.

| Data | Source | Schedule |
|---|---|---|
| Context, usage, average speed | `host.state.focusedUsage` | App-pushed |
| Model/provider | `session.info` | Bounded 20-chat map; unchanged values ignored |
| Model fallback | `session.status` | Cached with infinite stale time; only enabled when session event data is unknown and loading is ready; one error retry |
| Start time/title | `session.list` | Up to 4 successful reads while missing, 30 seconds apart; stops when found; no error retry |
| Account limits | `model.options` | 5 minutes + one 20-second warmup check after an empty first answer; one error retry; no focus/reconnect refetch |
| Background jobs | `process.list` | Every 30 seconds while active/loading ready |
| Subagents | `subagent.list` | Initial read, start/complete invalidations; every 20 seconds while any run, gated by readiness |
| Live speed/completions | `message.delta`, `reasoning.delta`, `subagent.*` | Existing app events; in-memory readouts |

Start-time lookup includes hidden/bot chats and the focused owner's profile, but requests only the **100 most recent chats**. Older/unlisted chats may have no duration after the bounded attempts.

Session details are deferred through two animation frames and an idle callback (timeout/fallback), then enabled in stages about 250 ms apart: model, start time, jobs/subagents. This is a scheduling heuristic—not proof the whole chat has loaded, nor a wait for each RPC to finish before enabling the next.

Hidden/unfocused copies gate all five queries, duration/live-rate timers and width measurement. They still have subscriptions, pane-attribute visibility observers and a **5-second safety check**. The shared/cached limits query is enabled only in the visible, focused copy after the final loading stage; event handlers remain registered even when the line is hidden. Active duration ticks every 5 seconds; live rate every 500 ms while busy, otherwise every 5 seconds. Hidden copies are not claimed to do no work.

Model, speed and completion trackers are capped at 20 chats; completions retain up to 5 entries/chat. They are not persisted. Query caching is supplied by Hermes. Formats and thresholds follow the terminal where applicable.

## Privacy and security

- No plugin file writes, model calls, direct web requests, dynamic code loading or new persistent tracking.
- Known old **test-build** keys `visible`, `limitMode`, `sessionAvg` are read for cleanup and removed **only if present**. Fresh installs perform no storage writes; view choices remain in memory.
- Only read-only Hermes RPCs are used. `model.options` reads cached usage and can request background provider refreshes by Hermes; local RPC does not mean no external backend activity.
- Values are plain text, not HTML. This is a display choice, **not a plugin sandbox or security guarantee**.
- Command/goal previews use **best-effort pattern redaction** (`••••`). Unrecognized secrets can remain visible; legitimate text can be hidden. Do not rely on it to sanitize screenshots or safely handle credentials.

See [SECURITY.md](SECURITY.md) for private reporting and support.

## Compatibility and verification limits

Previously built/tested on **Hermes Agent v0.22.0** (`v0.22.0+167.ge8c8e46`, October 2026), Windows 11, dark theme. This does not confirm every unreleased fix on screen. Internal RPC shapes, status text, focused-state atoms, pane/tab attributes and events can change; check the line after Hermes updates. Breakage is not guaranteed to stay isolated to one item.

Still unverified: light theme, macOS/Linux, other Hermes versions, remote gateways, real pooled accounts, screen readers, and real providers beyond Claude/ChatGPT (other-provider cases use fixtures). Amber blends a fixed warning colour with theme text; other tones use theme variables.

Measured chat-switch lag attribution remains **inconclusive**. Scheduling changes and helper tests do not establish an end-to-end performance improvement.

## Tests and contributions

Run the dependency-free Node.js suite from this folder:

```bash
node --test *.test.cjs
```

Tests use fixtures, VM/SDK stand-ins and simulated lifecycle checks. They cover helper behavior, polling bounds, modes, trackers, redaction and source restrictions; they are **not actual React/browser integration tests** and do not replace desktop checks of visibility restoration, split focus, rapid switching, dialogs or enable/disable behavior.

GitHub runs `node --test *.test.cjs` for pull requests and pushes to `main`, including the lifecycle simulations; the `test` check is required before merge. PRs are required, but **zero human approvals are required** by branch protection. Dependabot checks pinned GitHub Actions weekly.

## Credits and licence

Subscription polling fixes, weekly-only windows and initial tests: [@audioclass](https://github.com/audioclass) ([#1](https://github.com/Alex-Toronto/hermes-cli-status-line/pull/1)).

MIT. See [LICENSE](LICENSE).
