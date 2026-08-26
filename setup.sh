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
  echo "Installing @earendil-works/pi-coding-agent..."
  npm install -g @earendil-works/pi-coding-agent
fi

packages=(
  "npm:pi-mcp-adapter"
  "npm:@juicesharp/rpiv-ask-user-question"
  "npm:pi-schedule-prompt"
  "npm:pi-rewind"
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
)

# pi install updates an already-installed source in place rather than failing,
# so calling it every run keeps this idempotent without checking settings.json first.
for pkg in "${packages[@]}"; do
  echo "Installing $pkg..."
  pi install "$pkg"
done

mkdir -p "$AGENT_DIR/agents"

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
for src in "$SCRIPT_DIR"/templates/agents/*.md; do
  seed_file "$src" "$AGENT_DIR/agents/$(basename "$src")"
done

node -e '
const fs = require("fs");
const settingsPath = process.argv[1];
let settings = {};
if (fs.existsSync(settingsPath)) {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
}
if (!("tuiMode" in settings)) settings.tuiMode = "fullscreen";
if (!("theme" in settings)) settings.theme = "dark";
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
' "$AGENT_DIR/settings.json"

cat <<EOF

Setup complete. Next steps:
  1. Start pi and authenticate: run /login, or export a provider API key.
  2. Pick a default provider and model.
  3. Optionally set the guardian review model in $AGENT_DIR/jpi.kdl.
  4. Export DD_DEV_TOKEN if you want the datadog-dev MCP server.
EOF
