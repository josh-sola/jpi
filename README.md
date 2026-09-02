# jpi

This is a bootstrap for the Pi coding agent (`@earendil-works/pi-coding-agent`),
set up the way Josh runs it. Running `setup.sh` installs his usual extensions
and drops in starter config files.

## Coming from the old jpi-* repos?

The 12 separate `jpi-*` repos (prompt, guardian, status, memory, web, title,
background, subagents, tasks, scratchpad, style, history) are archived —
everything they did now lives in this one repo. Re-run `setup.sh` from here;
it migrates an existing machine automatically.

## Quick start

```
git clone git@github.com:josh-sola/jpi.git && cd jpi && ./setup.sh
```

## Have your agent do it

Point your coding agent at `ONBOARDING.md` and ask it to follow the
instructions there. Raw URL:

```
https://raw.githubusercontent.com/josh-sola/jpi/main/ONBOARDING.md
```

## What gets installed

| Package                              | What it is                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-mcp-adapter`                     | Bridges MCP servers into Pi's tool set.                                                                                                                                                                                                                                                                                |
| `@juicesharp/rpiv-ask-user-question` | Adds an `ask_user_question` tool for mid-task clarification.                                                                                                                                                                                                                                                           |
| `pi-schedule-prompt`                 | Schedules a prompt to run later.                                                                                                                                                                                                                                                                                       |
| `pi-rewind`                          | Rewinds a session to an earlier point.                                                                                                                                                                                                                                                                                 |
| `jpi`                                | One package holding all of Josh's modules: the system prompt, guardian, status, memory, web, exa-web, title, background, subagents, tasks, scratchpad, style, and history. Each module has its own stanza in `jpi.kdl`, and setting that stanza's `enabled` field to `#false` turns the module off (restart required). |

## What gets configured

`setup.sh` seeds these files under the Pi agent directory
(`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`):

- `jpi.kdl` — settings for the jpi modules (from `templates/jpi.kdl`)
- `mcp.json` — the MCP server registry (from `templates/mcp.json`)
- `settings.json` — merges in UI and behavior defaults from
  `templates/settings-defaults.json`, only for keys you haven't set

It never overwrites a file that already exists there. If you already have
one of these files, `setup.sh` leaves it alone and tells you so.

## After setup

1. Start `pi` and authenticate: run `/login`, or set a provider API key.
2. Pick a default model.
3. Optionally set the guardian review model in `jpi.kdl` — see the comment
   above the `model` line in the `guardian { }` section.
4. Guardian has two separate off switches: `/guardian off` pauses review for
   the current session only, while `enabled #false` in `jpi.kdl`'s
   `guardian { }` section unloads the module entirely and needs a restart to
   turn back on.

## Re-running is safe

`setup.sh` is idempotent. Run it again any time — it re-syncs packages and
never touches a config file you already have.

## Repo layout and development

This repo is two things at once: the bootstrap (`setup.sh` plus
`templates/`) and the `jpi` pi package itself.

```
extensions/jpi/    the one pi extension: loads every module in modules/
modules/<name>/     one directory per module (guardian, status, memory, ...)
src/core/           shared library code (config, store, agent-dir helpers)
src/pi/             the one place jpi reaches past Pi's public extension API (see src/pi/README.md)
tests/              tests, mirroring modules/ and src/core/
```

Each module's settings live in its own stanza in `jpi.kdl`; setting that
stanza's `enabled` field to `#false` stops the module from loading at all
(you need to restart `pi` for the change to take effect — this is different
from a runtime toggle like `/guardian off`, which only pauses guardian for
the current session). `web` (Ketch) and `exa-web` (direct Exa REST) are
mutually exclusive: keep one enabled. `exa-web` is disabled by default and
uses `api-key` when set, otherwise `EXA_API_KEY`.

Dev commands, run from the repo root:

- `npm install` — install dependencies
- `vp check` — lint and type-check
- `vp test` — run the test suite
- `pi -e .` — load this checkout into a Pi session without installing it
