# Changelog

## 1.2.1 — 2026-10-15

- Resolve per-chat models from `session.info` in a bounded map; use a cached `session.status` fallback only when unknown and ignore unchanged model events.
- Gate session queries, active timers and width measurement on focused/visible state. Observe Hermes pane-visibility attributes, with a 5-second safety check, to restore the line after navigation without treating dialogs as hidden tabs.
- Defer session detail queries through frames/idle and stagger their enablement. Tag readiness by chat identity so a rapid switch cannot reuse the previous chat's stage; cancel both queued frames and idle/timer work on cleanup. This does not prove the chat is fully loaded or serialize RPC completion.
- Gate the shared limits query while hidden/off too; include all `*.test.cjs` files in CI.
- Poll background jobs every 30 seconds. Keep limits at 5 minutes plus one 20-second empty-first-response warmup, and missing start-time lookups bounded to 4 reads 30 seconds apart (the latest 100 chats only).
- Expand best-effort credential redaction and regression coverage, including simulated lifecycle cases. These tests are not React/browser integration tests.
- Correct data-source, width/context-mode, split-name, storage-cleanup and repository-security documentation. Remove unsupported overhead/security assurances; chat-switch lag attribution remains inconclusive and not all fixes have been checked on screen.

Install examples are pinned to **v1.2.1**.

## 1.2.0 — 2026-10-15

- Merge context numbers/meter into one item; click cycles both, meter only and numbers only.
- Prefix split-view readouts with the focused pane's chat name, including bot names.
- Support duration/title lookup for bot chats in other profiles; declare the plugin version.

## 1.1.1 — 2026-10-15

- Include hidden/bot chats in start-time lookup and bound retries for unlisted chats.
- Add Dependabot updates for pinned GitHub Actions; mark light-theme verification outstanding.

## 1.1.0 — 2026-10-15

- Display limits from any provider reporting usage windows, with Claude/GPT first.
- Use 5-minute limit polling and one 20-second warmup after an empty first response.
- Show the line only in the focused split pane; add emoji fallback fonts.
- Add GitHub test automation and compatibility/untested-area notes.

## 1.0.0 — 2026-10-15

- Initial numbered release: terminal-style model, context, cache, average/live speed, compression, background-job, subagent, duration, token-total and Claude/GPT limit readouts.
- Add used/left limit switching, plain-text hover cards and best-effort secret redaction; keep plugin tracking in memory.

Published entries are summarized from the repository's GitHub release notes, not a claim of renewed testing on those versions. Historical verification targeted Hermes v0.22.0 on Windows 11; see README for current gaps.
