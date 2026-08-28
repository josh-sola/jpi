#!/usr/bin/env bash
set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. Install Node >= 24, then re-run this script." >&2
  exit 1
fi

node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 24 ]; then
  echo "node $node_major found; pi needs Node >= 24. Upgrade node, then re-run this script." >&2
  exit 1
fi

if ! command -v pi >/dev/null 2>&1; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "pnpm not found. Install pnpm, then re-run this script." >&2
    exit 1
  fi
  echo "Installing @earendil-works/pi-coding-agent..."
  # fails with "Unable to find the global bin directory" until `pnpm setup`
  # has run once; point the user there instead of leaving a bare pnpm error
  if ! pnpm add -g @earendil-works/pi-coding-agent; then
    echo "pnpm add -g failed. If it could not find a global bin directory, run 'pnpm setup', restart your shell, and re-run this script." >&2
    exit 1
  fi
fi

# Order among these entries is now inert (prompt ordering is internal to the
# jpi package). jpi is listed first only to keep settings.json diffs boring.
packages=(
  "git:github.com/josh-sola/jpi"
  "npm:pi-mcp-adapter"
  "npm:@juicesharp/rpiv-ask-user-question"
  "npm:pi-schedule-prompt"
  "npm:pi-rewind"
)

# Superseded by the single jpi package; removed so old and new extensions
# don't run side by side. Gated on presence: `pi remove` on a source that
# was never installed is untested, and settings.json may not exist yet.
old_sources=(
  "git:github.com/josh-sola/jpi-prompt"
  "git:github.com/josh-sola/jpi-guardian"
  "git:github.com/josh-sola/jpi-status"
  "git:github.com/josh-sola/jpi-memory"
  "git:github.com/josh-sola/jpi-web"
  "git:github.com/josh-sola/jpi-title"
  "git:github.com/josh-sola/jpi-background"
  "git:github.com/josh-sola/jpi-subagents"
  "git:github.com/josh-sola/jpi-tasks"
  "git:github.com/josh-sola/jpi-scratchpad"
  "git:github.com/josh-sola/jpi-style"
  "git:github.com/josh-sola/jpi-history"
)
for src in "${old_sources[@]}"; do
  if [ -f "$AGENT_DIR/settings.json" ] && grep -q "\"$src\"" "$AGENT_DIR/settings.json"; then
    echo "Removing superseded $src..."
    pi remove "$src"
  fi
done

# pi install updates an already-installed source in place rather than failing,
# so calling it every run keeps this idempotent without checking settings.json first.
for pkg in "${packages[@]}"; do
  echo "Installing $pkg..."
  pi install "$pkg"
done

mkdir -p "$AGENT_DIR"

seed_file() {
  local src="$1" dest="$2"
  if [ -f "$dest" ]; then
    echo "Left alone (already exists): $dest"
  else
    cp "$src" "$dest"
    echo "Wrote $dest"
  fi
}

seed_file "$SCRIPT_DIR/templates/jpi.kdl" "$AGENT_DIR/jpi.kdl"
seed_file "$SCRIPT_DIR/templates/mcp.json" "$AGENT_DIR/mcp.json"

node -e '
const fs = require("fs");
const [settingsPath, defaultsPath] = process.argv.slice(1);
let settings = {};
if (fs.existsSync(settingsPath)) {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
}
const defaults = JSON.parse(fs.readFileSync(defaultsPath, "utf-8"));
for (const [key, value] of Object.entries(defaults)) {
  if (!(key in settings)) settings[key] = value;
}
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
' "$AGENT_DIR/settings.json" "$SCRIPT_DIR/templates/settings-defaults.json"

cat <<EOF

Setup complete. Next steps:
  1. Start pi and authenticate: run /login, or export a provider API key.
  2. Pick a default provider and model.
  3. Optionally set the guardian review model in $AGENT_DIR/jpi.kdl.
EOF
