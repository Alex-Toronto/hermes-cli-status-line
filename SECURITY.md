# Security policy

## Reporting a problem

Please report security problems privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue for them.

Include what you saw, the plugin version (release tag) and your Hermes desktop version. You'll get a reply as soon as practical.

## What this plugin does and doesn't do

- It runs inside the Hermes desktop app and only reads data the app already gives plugins, through read-only requests (`session.status`, `session.list`, `model.options`, `process.list`, `subagent.list`) and events the app already receives.
- It makes no network requests of its own, loads no code, writes no files and saves nothing in app storage.
- It shows text as plain text only, never as HTML.
- It hides anything that looks like a key, token or password in the background-command and subagent text it displays. This is a best-effort pattern match.

## Supported versions

Only the latest release receives fixes.

## Changes to this repository

All changes reach `main` through a reviewed pull request; direct pushes and force-pushes to `main` are blocked. Outside contributions are reviewed line by line before merging. Install a numbered release rather than `main`.
