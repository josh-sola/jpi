# jpi

This is a bootstrap for the Pi coding agent (`@earendil-works/pi-coding-agent`),
set up the way Josh runs it. Running `setup.sh` installs his usual extensions
and drops in starter config files.

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

| Package | What it is |
| --- | --- |
| `pi-mcp-adapter` | Bridges MCP servers into Pi's tool set. |
| `@juicesharp/rpiv-ask-user-question` | Adds an `ask_user_question` tool for mid-task clarification. |
| `pi-schedule-prompt` | Schedules a prompt to run later. |
| `pi-rewind` | Rewinds a session to an earlier point. |
| `jpi-guardian` | Auto-review gate for tool calls, configured in the `guardian { }` section of `jpi.kdl`. |
| `jpi-status` | Configurable status footer, configured in the `status { }` section of `jpi.kdl`. |
| `jpi-memory` | Persistent memory: one markdown file per fact plus an index, under the agent dir. |
| `jpi-web` | `web_search` / `web_fetch` tools backed by a keyless DuckDuckGo client. |
| `jpi-title` | Activity-aware terminal tab titles. |
| `jpi-background` | Background shell tasks and streaming watches, configured in the `background { }` section of `jpi.kdl`. |
| `jpi-subagents` | Claude-Code-style subagents: a fleet view, delegation, and nested agents. |
| `jpi-tasks` | A plain todo list: create/list/update tasks, plus a persistent widget. |
| `jpi-scratchpad` | A session scratchpad directory, steering the model away from `/tmp`. |
| `jpi-style` | Claude-Code-style rendering for tool calls and results. |

## What gets configured

`setup.sh` seeds these files under the Pi agent directory
(`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`):

- `jpi.kdl` — settings for the jpi plugins (from `templates/jpi.kdl`)
- `mcp.json` — the MCP server registry (from `templates/mcp.json`)
- `agents/explore.md`, `agents/plan.md`, `agents/general-purpose.md` — custom
  subagent definitions (from `templates/agents/`)
- `settings.json` — merges in `tuiMode: "fullscreen"` and a `theme` default

It never overwrites a file that already exists there. If you already have
one of these files, `setup.sh` leaves it alone and tells you so.

## After setup

1. Start `pi` and authenticate: run `/login`, or set a provider API key.
2. Pick a default model.
3. Optionally set the guardian review model in `jpi.kdl` — see the comment
   above the `model` line in the `guardian { }` section.
4. Export `DD_DEV_TOKEN` if you want the `datadog-dev` MCP server.

## Re-running is safe

`setup.sh` is idempotent. Run it again any time — it re-syncs packages and
never touches a config file you already have.
