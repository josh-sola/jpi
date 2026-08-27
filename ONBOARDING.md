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
2. Installs the `pi` CLI globally via pnpm if it is not already on `PATH`.
3. Removes any of the 12 old `jpi-*` packages that are still installed (see
   the "coming from the old multi-repo jpi" section below).
4. Installs the 5 packages listed in the table below via `pi install`.
   Re-running this step is safe: `pi install` updates an already-installed
   package rather than failing.
5. Seeds `jpi.kdl`, `mcp.json`, and `JPI-SYSTEM.md` into the Pi agent
   directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) — but only for
   files that do not already exist there.
6. Merges the UI and behavior defaults from `templates/settings-defaults.json`
   into `settings.json`, without touching any key already set there.
7. Prints next steps for the human (see part 4 below).

Do not re-implement these steps yourself — just run the script and report
what happened.

## 3. Verify

After `setup.sh` finishes, confirm:

- `pi list` shows exactly the 5 packages from the table below, and none of
  the 12 old `jpi-*` packages (`jpi-prompt`, `jpi-guardian`, `jpi-status`,
  `jpi-memory`, `jpi-web`, `jpi-title`, `jpi-background`, `jpi-subagents`,
  `jpi-tasks`, `jpi-scratchpad`, `jpi-style`, `jpi-history`).
- `$AGENT_DIR/jpi.kdl` exists.
- `$AGENT_DIR/mcp.json` exists.
- `$AGENT_DIR/JPI-SYSTEM.md` exists.
- `$AGENT_DIR/settings.json` has a `packages` array containing the 5
  package sources from the table below.

(`$AGENT_DIR` is `$PI_CODING_AGENT_DIR`, or `~/.pi/agent` if that variable
is unset.)

## 4. Finish with the human

These steps need a person, not just the agent:

- **Authentication** — run `/login` inside `pi`, or set a provider API key
  as an environment variable.
- **Default provider and model** — pick one in `pi`'s settings.
- **Guardian review model** — jpi's guardian module auto-reviews tool calls
  before they run. Reviews default to `anthropic/claude-sonnet-5`; to use a
  different model, set it in the `guardian { }` section of `jpi.kdl` (see the
  comment above the `model` line there).

## Troubleshooting

- **Node is older than 24** — `setup.sh` exits with a message saying so.
  Upgrade Node and re-run.
- **`pnpm add -g` can't find a global bin directory** — run `pnpm setup`,
  restart the shell, and re-run `setup.sh`.
- **A config file already existed** — `setup.sh` prints "Left alone" for
  each file it skipped. Diff that file against the matching one in
  `templates/` yourself to see what's different, and decide whether the
  person wants to adopt any of it.
- **Something looks broken** — re-running `setup.sh` is always safe.
- **Removing a package** — `pi remove <source>`, using the same source
  string as in the table below (e.g. `pi remove git:github.com/josh-sola/jpi`).

## If you're coming from the old multi-repo jpi

The 12 `jpi-*` repos (prompt, guardian, status, memory, web, title,
background, subagents, tasks, scratchpad, style, history) are archived. Their
functionality all lives in this repo's single `jpi` package now. Just
re-running `setup.sh` from this repo migrates an existing machine
automatically: it removes the old packages and installs the new one. Your
`jpi.kdl` carries over unchanged — the module stanzas it already has (all 12
plus `enabled`) keep working, and any stanza you're missing appears the first
time you start `pi` after the new package is installed.

## Plugin overview

| Package                                  | What it is                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm:pi-mcp-adapter`                     | Bridges MCP servers into Pi's tool set.                                                                                                                                                                                                                                                                       |
| `npm:@juicesharp/rpiv-ask-user-question` | Adds an `ask_user_question` tool for mid-task clarification.                                                                                                                                                                                                                                                  |
| `npm:pi-schedule-prompt`                 | Schedules a prompt to run later.                                                                                                                                                                                                                                                                              |
| `npm:pi-rewind`                          | Rewinds a session to an earlier point.                                                                                                                                                                                                                                                                        |
| `git:github.com/josh-sola/jpi`           | One package holding all of Josh's modules: the system prompt, guardian, status, memory, web, title, background, subagents, tasks, scratchpad, style, and history. Each module has its own stanza in `jpi.kdl`, and setting that stanza's `enabled` field to `#false` turns the module off (restart required). |
