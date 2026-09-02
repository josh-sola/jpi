# jpi repository

This git repository contains both the consolidated `jpi` plugin for the Pi
coding agent (`@earendil-works/pi-coding-agent`) and its bootstrap. The plugin
is distributed from `git@github.com:josh-sola/jpi.git`; nothing is published
to npm. The default branch is `main`.

## Repository layout

```
package.json            package metadata, dependencies, Pi extension/theme entries,
                        and the postinstall ketch download
extensions/jpi/index.ts the one extension; its ordered MODULES array loads every module
modules/<name>/         one directory per module; module.ts exports a JpiModule
src/core/               shared Config, schema-builder, Store, tool-registration,
                        project-slug, and scratchpad helpers
src/pi/                 the only non-test code allowed to reach past Pi's public API
tests/<name>/           module tests; tests/pi contains upstream compatibility canaries
themes/                 Pi themes shipped with the package
setup.sh, templates/, ONBOARDING.md, README.md
                        bootstrap and onboarding surface
scripts/install-ketch.mjs, ketch-release.json
                        pinned ketch installer and release metadata
```

The 14 modules, in load order, are prompt, guardian, status, memory, web,
title, background, subagents, tasks, scratchpad, btw, schedule, style, and
history.

## Module rules

- Every module declares a stanza in `<agentDir>/jpi.kdl`; its `section` is
  normally its module name. The loader injects an `enabled` field, rendered
  first with a default of `#true`, so module schemas must not declare their
  own. `enabled #false` prevents the module from loading and requires a
  restart to re-enable it. A missing stanza is seeded with defaults on first
  run.
- Module order in `extensions/jpi/index.ts` is load-bearing. Prompt must run
  before memory and scratchpad append to the system prompt. Style runs near
  the end because it re-registers built-in tools. History runs last because
  the last `setEditorComponent` caller wins. Do not reorder modules casually.
- A module setup failure is caught and shown with `ctx.ui.notify`; the other
  modules continue loading.
- Guardian has two distinct switches: `/guardian on|off` pauses or resumes it
  for the current session, while `enabled #false` is a restart-required hard
  disable.

## Pi-internal boundary

Code that mirrors private Pi types, patches prototypes, or reads private fields
belongs in `src/pi/` and nowhere else. Couplings that cannot move there carry a
`// pi-internal(<topic>)` marker and are recorded in `src/pi/README.md`. Read
that file before changing Pi-internal code. On a Pi dependency bump, follow
its upgrade checklist and run `vp test tests/pi` before the full suite.

## Stable external contracts

`jpi-sidebar` and `jpi-planter` consume these contracts from outside this
repository. Keep them byte-identical unless all consumers are updated with
them:

- bus channels `jpi-background:{request,response,terminal,tasks}:v1` and
  `subagents:*`, including
  `subagents:fleet:{provider,consumer-ready}:v1`
- `globalThis[Symbol.for("pi-subagents:manager")]`
- Store paths under `<agentDir>/jpi/<name>/`, especially
  `jpi/tasks/<project-slug>/{session-<id>,project}.json`
- the `Task*` tool names
- `jpi.kdl` section names

## Working here

- Use Node 24 or later. Install dependencies with `npm install`.
- Run `vp check` for lint and type checks, and `vp test` for the full suite.
- Use `pi -e .` to load this checkout for a live session.
- Never run `vp exec`; it silently adds `devEngines` to `package.json`.
- Do not add a `prepare` script or `devEngines` to `package.json`. They break
  `pi install`, which runs `npm install --omit=dev`.
- Keep `vite.config.ts`'s `test.server.deps.inline` and `resolve.dedupe`
  settings for `@earendil-works/pi-ai`; the subagent e2e tests require one
  shared provider registry.
- Show startup configuration problems with `ctx.ui.notify` from a
  `session_start` handler. Do not use `console.log`, which garbles the TUI.
