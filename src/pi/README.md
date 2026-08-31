# src/pi

This is the one place in jpi allowed to reach past Pi's public extension API.
Everything here either mirrors a Pi-internal type, monkeypatches a Pi object,
or duplicates behavior Pi keeps unexported. When Pi ships a new version, this
directory is where to check.

## Rules

- `src/pi/` is the only non-test directory allowed to declare Pi-internal
  type mirrors or patch/reach into Pi objects.
- `src/core` may import from `src/pi`. `src/pi` must never import from
  `src/core` — the dependency only runs one way.
- A coupling that can't be moved here yet (it's still entangled with a
  module) gets a marker comment at its call site instead:

  ```
  // pi-internal(<topic>): <one-line why>
  ```

  `<topic>` groups related markers so they can be swept together later. See
  "Markers elsewhere" below for the sites that carry one today.

## Couplings in this directory

| File                                     | Depends on (upstream)                                                                                                                                                                                                       | Verified against                         | Fails if upstream changes                                                                                                                                                                  | Canary |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `types.ts`                               | The shape of Pi's `pi.events` bus (`emit`/`on`) and the `onBeforeAgentStart` event payload (`{ systemPrompt }`) — neither is an exported type from `@earendil-works/pi-coding-agent`, so these are hand-written mirrors.    | `@earendil-works/pi-coding-agent@0.84.4` | Pi renames or reshapes the bus methods, or changes the before-agent-start payload — jpi's mirror silently drifts out of sync with no compiler error.                                       | TBD    |
| `settings.ts` (`getAgentDirectory`)      | Pi's own agent-directory resolution: `PI_CODING_AGENT_DIR` env var, default `~/.pi/agent`. Pi doesn't export this logic, so jpi re-derives it to find `jpi.kdl` and friends.                                                | `@earendil-works/pi-coding-agent@0.84.4` | Pi changes the env var name or the default path — jpi and Pi resolve to different directories and jpi's config goes silently missing (or gets created somewhere new).                      | TBD    |
| `extension-api.ts` (`cloneExtensionApi`) | `ExtensionAPI`'s members being own enumerable properties, so `{ ...pi, ...overrides }` picks up every one of them.                                                                                                          | `@earendil-works/pi-coding-agent@0.84.4` | Pi turns `ExtensionAPI` into a class instance, or moves members onto a prototype or behind getters — the spread stops copying them and every decorated method silently disappears.         | TBD    |
| `markdown.ts` (`resolveMarkdownTheme`)   | `getMarkdownTheme()`'s lazy-throw behavior: it returns arrow functions that read Pi's global theme lazily, so calling one before `initTheme()` has run throws inside `render()`, not at the `getMarkdownTheme()` call site. | `@earendil-works/pi-coding-agent@0.84.4` | Pi changes `getMarkdownTheme()` to throw eagerly (breaking the probe-based try/catch) or to return successfully with an unusable theme (silently skipping the fallback when it shouldn't). | TBD    |

## Markers elsewhere

Empty for now — no module-level code has been swept into `src/pi/` yet.
Later steps will move per-module couplings here and, where a coupling can't
move cleanly, leave a `// pi-internal(<topic>): <one-line why>` marker at the
call site instead. This section will then list each topic and where its
markers live.

## Upgrade checklist

On a Pi version bump:

1. Run `vp test tests/pi` (this suite doesn't exist yet — a later step adds
   canary tests here, one per coupling above).
2. Review every `pi-internal(...)` marker site for a topic that still says
   "TBD" under Canary — those have no automated check, so read the upstream
   changelog by hand for that topic.
