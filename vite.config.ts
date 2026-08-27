import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      // Byte-exact test fixture (subagents' tool-description-mode test pins it against the extension's built-in description) — reformatting it breaks that pin.
      "tests/subagents/fixtures/agent-tool-description.md",
    ],
  },
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // Spreading a Set before iterating snapshots it against handlers that
      // unsubscribe themselves mid-iteration; not the useless copy this rule assumes.
      "unicorn/no-useless-spread": "off",
      // String() is the deliberate fallback rendering for non-record values in toJsonValue.
      "typescript/no-base-to-string": "off",
      // pi.on/registerCommand take these methods as plain closures with no `this`.
      "typescript/unbound-method": "off",
      // Several modules strip ANSI/control bytes on purpose (footer and title rendering,
      // widget output comparisons, untrusted page text) — the control characters these
      // regexes match are required, not accidental.
      "eslint/no-control-regex": "off",
      // matches is always the executable paths findExecutable collects; default lexicographic order is correct.
      "require-array-sort-compare": "off",
    },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    // The merged suite saturates every worker thread; timing-sensitive tests
    // that pass alone in <1s can exceed vitest's 5s default under that load.
    testTimeout: 20_000,
    // The print-mode e2e tests register a faux pi-ai provider and need the session
    // to stream through that same pi-ai instance. npm duplicates pi-ai (top-level +
    // nested under pi-coding-agent), yielding two registries and "No API provider
    // registered". Inlining routes the @earendil-works packages through Vite's
    // resolver so dedupe can collapse pi-ai; dedupe alone skips externalized modules.
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
