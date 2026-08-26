# Onboarding

You are an agent helping a person set up the Pi coding agent
(`@earendil-works/pi-coding-agent`) with Josh's usual extensions and starter
config. Follow the steps below.

## 1. Get the repo

If this file was fetched standalone, clone the repo first:

```
git clone git@github.com:josh-sola/jpi.git
cd jpi
```

If you are already inside a checkout of this repo, skip cloning.

## 2. Run setup

Run `./setup.sh` from the repo root and watch its output for errors.

The script, in order:

1. Checks Node is installed and its major version is at least 24. It exits
   with a clear message if not — see Troubleshooting below.
2. Installs the `pi` CLI globally if it is not already on `PATH`.
3. Installs the 14 packages listed in the table below via `pi install`.
   Re-running this step is safe: `pi install` updates an already-installed
   package rather than failing.
4. Seeds `jpi.kdl`, `mcp.json`, and the three files under `agents/` into
   the Pi agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) —
   but only for files that do not already exist there.
5. Merges `tuiMode` and `theme` defaults into `settings.json`, without
   touching any other key already set there.
6. Prints next steps for the human (see part 4 below).

Do not re-implement these steps yourself — just run the script and report
what happened.

## 3. Verify

After `setup.sh` finishes, confirm:

- `pi list` shows all 14 packages from the table below.
- `$AGENT_DIR/jpi.kdl` exists.
- `$AGENT_DIR/mcp.json` exists.
- `$AGENT_DIR/agents/explore.md`, `agents/plan.md`, and
  `agents/general-purpose.md` all exist.
- `$AGENT_DIR/settings.json` has a `packages` array containing the 14
  package sources.

(`$AGENT_DIR` is `$PI_CODING_AGENT_DIR`, or `~/.pi/agent` if that variable
is unset.)

## 4. Finish with the human

These steps need a person, not just the agent:

- **Authentication** — run `/login` inside `pi`, or set a provider API key
  as an environment variable.
- **Default provider and model** — pick one in `pi`'s settings.
- **Guardian review model** — `jpi-guardian` auto-reviews tool calls before
  they run. Reviews default to `anthropic/claude-sonnet-5`; to use a different
  model, set it in the `guardian { }` section of `jpi.kdl` (see the comment
  above the `model` line there).
- **`DD_DEV_TOKEN`** — export this environment variable if the person wants
  the `datadog-dev` MCP server (it authenticates with a bearer token from
  this variable; `datadog-prod` uses OAuth instead and needs no token).

## Troubleshooting

- **Node is older than 24** — `setup.sh` exits with a message saying so.
  Upgrade Node and re-run.
- **A config file already existed** — `setup.sh` prints "Left alone" for
  each file it skipped. Diff that file against the matching one in
  `templates/` yourself to see what's different, and decide whether the
  person wants to adopt any of it.
- **Something looks broken** — re-running `setup.sh` is always safe.
- **Removing a package** — `pi remove <source>`, using the same source
  string as in the table below (e.g. `pi remove git:github.com/josh-sola/jpi-tasks`).

## Plugin overview

| Package | What it is |
| --- | --- |
| `npm:pi-mcp-adapter` | Bridges MCP servers into Pi's tool set. |
| `npm:@juicesharp/rpiv-ask-user-question` | Adds an `ask_user_question` tool for mid-task clarification. |
| `npm:pi-schedule-prompt` | Schedules a prompt to run later. |
| `npm:pi-rewind` | Rewinds a session to an earlier point. |
| `git:github.com/josh-sola/jpi-guardian` | Auto-review gate for tool calls, configured in the `guardian { }` section of `jpi.kdl`. |
| `git:github.com/josh-sola/jpi-status` | Configurable status footer, configured in the `status { }` section of `jpi.kdl`. |
| `git:github.com/josh-sola/jpi-memory` | Persistent memory: one markdown file per fact plus an index, under the agent dir. |
| `git:github.com/josh-sola/jpi-web` | `web_search` / `web_fetch` tools backed by a keyless DuckDuckGo client. |
| `git:github.com/josh-sola/jpi-title` | Activity-aware terminal tab titles. |
| `git:github.com/josh-sola/jpi-background` | Background shell tasks and streaming watches, configured in the `background { }` section of `jpi.kdl`. |
| `git:github.com/josh-sola/jpi-subagents` | Claude-Code-style subagents: a fleet view, delegation, and nested agents. |
| `git:github.com/josh-sola/jpi-tasks` | A plain todo list: create/list/update tasks, plus a persistent widget. |
| `git:github.com/josh-sola/jpi-scratchpad` | A session scratchpad directory, steering the model away from `/tmp`. |
| `git:github.com/josh-sola/jpi-style` | Claude-Code-style rendering for tool calls and results. |

Not installed by this repo: `jpi-planter` (talks to a personal macOS app)
and `jpi-sidebar` (a personal TUI sidebar). `jpi-base` is a shared library
the other plugins depend on, not something installed on its own.
