# Security policy

## Report privately

Use this repository's **Security → Report a vulnerability** page, not a public issue. Include the plugin release tag, Hermes desktop version and a reproduction without real credentials. A reply will follow as soon as practical.

## Scope and limitations

- The plugin runs inside Hermes desktop. It reads focused app state, existing events and read-only RPCs: `session.status`, `session.list`, `model.options`, `process.list`, `subagent.list`.
- It makes no direct network or model calls, adds nothing to chat context and dynamically loads no code. Local Hermes RPCs can cause backend work: `model.options` can trigger background provider usage refreshes. This is not a guarantee of no external activity or negligible runtime cost.
- Only usage and context display preferences are persisted through Hermes's client-local plugin storage (`limitMode`, `contextMode`). They are written only when changed by the user. Model/speed/subagent trackers, usage history and chat content are not persisted by the plugin. Old test-build keys `visible` and `sessionAvg` are removed only if present; an existing `limitMode` is preserved. Registration performs no default writes. Storage errors leave controls working in memory.
- Display values are plain text, not HTML. This is not a sandbox or a blanket security guarantee.
- Command and subagent-goal previews receive **best-effort pattern redaction**. Patterns can miss secrets or hide legitimate text. Do not put credentials in commands/goals or assume screenshots have been sanitized.
- Hiding the line disables its queries and active readout timers, but is not disabling the plugin: visibility observers, a 5-second safety check and event subscriptions remain active. Already-started requests may finish. See README for scheduling and verification limits.

## Supported versions

Only the **latest published release** receives fixes. Development-branch changes are not a published security update.

## Repository protections

Changes to `main` require a pull request and the passing `test` status check; direct and force pushes are blocked by branch protection, including for administrators. Required human approvals are **zero**—PR-only protection does not guarantee independent human review. Install numbered releases rather than `main`.

Tests use fixtures and simulated lifecycle/SDK stand-ins, not actual React/browser integration. Passing tests do not prove complete secret detection or that every fix has been checked on screen.
