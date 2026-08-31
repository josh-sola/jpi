/**
 * boundary.test.ts — enforces src/pi/README.md's own rules over the repo's
 * real source tree, so "src/pi/ is the only place allowed to reach past
 * Pi's public API" stays true by construction, not just by convention:
 *
 *   1. No deep import of an `@earendil-works/<pkg>/dist/...` path outside
 *      `src/pi/` and `tests/pi/` (tests/pi/ is the canary suite — the one
 *      other place allowed to touch real Pi internals directly, per
 *      src/pi/README.md's own "Rules" section and the brief this suite was
 *      written against), except one explicitly allowlisted historical site.
 *   2. No `X.prototype.<member> = ` assignment outside `src/pi/`/`tests/pi/`
 *      — same tests/pi/ exemption, since a canary that proves a monkeypatch
 *      installs (e.g. restoring the original after the test) has to do the
 *      same raw assignment the patch itself does.
 *   3. Every `pi-internal(<topic>)` marker in the repo is tracked in the
 *      ledger, and every topic the ledger's "Markers elsewhere" table lists
 *      still has a real marker in code (no stale rows, no untracked reach-ins).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const README_PATH = join(REPO_ROOT, "src", "pi", "README.md");

const SKIP_DIR_NAMES = new Set(["node_modules", "local", "plans"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

/**
 * Every source file in the repo, skipping node_modules/local/plans, any
 * dotdir (.git included), and following no symlinks (`plans` itself is one,
 * pointing outside the worktree — this is belt-and-suspenders with the
 * explicit skip above).
 */
function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const SOURCE_FILES = walkSourceFiles(REPO_ROOT);

function relPath(filePath: string): string {
  return relative(REPO_ROOT, filePath).split("\\").join("/");
}

function isCanaryOwned(rel: string): boolean {
  return rel.startsWith("src/pi/") || rel.startsWith("tests/pi/");
}

interface FileEntry {
  rel: string;
  content: string;
}

const FILES: FileEntry[] = SOURCE_FILES.map((filePath) => ({
  rel: relPath(filePath),
  content: readFileSync(filePath, "utf-8"),
}));

// --- Rule 1: no deep `@earendil-works/<pkg>/dist/...` import outside src/pi/tests/pi ---

// Requires `from`/`import(`/`require(` immediately before the string
// literal — a plain comment mentioning a dist/ path (e.g. "see
// node_modules/@earendil-works/pi-tui/dist/keys.js" for a doc pointer)
// isn't an import specifier and shouldn't trip this rule.
const DEEP_IMPORT_RE =
  /(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\()\s*["']@earendil-works\/[a-zA-Z0-9._-]+\/dist\/[^"']*["']/g;

/**
 * The one pre-existing exception: pi-tui declares no `exports` map, so this
 * deep import works today (see the `pi-internal(pi-tui-no-exports-map)`
 * marker at its call site) but would break the moment pi-tui gains one.
 * Adding to this list requires a matching `src/pi/README.md` ledger entry —
 * this constant is the single source of truth the boundary test checks
 * against, so a reviewer sees every exception in one place.
 */
const ALLOWED_DEEP_IMPORTS = new Set(["tests/history/mouse.test.ts"]);

// --- Rule 2: no `X.prototype.<member> = ` assignment outside src/pi/tests/pi ---

// Matches an assignment (not `===`/`!==`) — e.g. `Foo.prototype.bar = ...`.
// Deliberately not restricted to identifiers imported from `@earendil-works`
// (precise "is X an @earendil-works import" detection needs a real parser,
// which is more machinery than this boundary test needs) — any prototype
// assignment outside src/pi/tests/pi is suspicious enough to flag, and this
// repo has none today, so the allowlist starts empty.
const PROTOTYPE_ASSIGNMENT_RE = /\.prototype\.[A-Za-z0-9_$]+\s*=(?!=)/g;

/** Same shape/purpose as ALLOWED_DEEP_IMPORTS — empty today; add only with a matching ledger entry. */
const ALLOWED_PROTOTYPE_ASSIGNMENTS = new Set<string>([]);

describe("boundary: Pi-internal reach-ins stay inside src/pi/ and tests/pi/", () => {
  it("found source files to check (sanity: the walker isn't silently empty)", () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES.some((f) => f.rel === "src/pi/index.ts")).toBe(true);
    expect(FILES.some((f) => f.rel.startsWith("node_modules/"))).toBe(false);
  });

  it("no deep @earendil-works/.../dist/ import outside src/pi/, tests/pi/, or the allowlist", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      if (isCanaryOwned(file.rel)) continue;
      if (ALLOWED_DEEP_IMPORTS.has(file.rel)) continue;
      if (DEEP_IMPORT_RE.test(file.content)) violations.push(file.rel);
      DEEP_IMPORT_RE.lastIndex = 0;
    }
    expect(violations).toEqual([]);
  });

  it("the allowlisted deep import still exists where expected (no stale allowlist entry)", () => {
    for (const rel of ALLOWED_DEEP_IMPORTS) {
      const file = FILES.find((f) => f.rel === rel);
      expect(file, `allowlisted file ${rel} not found`).toBeDefined();
      DEEP_IMPORT_RE.lastIndex = 0;
      expect(
        DEEP_IMPORT_RE.test(file!.content),
        `${rel} is allowlisted for a deep import it no longer contains`,
      ).toBe(true);
      DEEP_IMPORT_RE.lastIndex = 0;
    }
  });

  it("no .prototype.<member> = assignment outside src/pi/, tests/pi/, or the allowlist", () => {
    const violations: string[] = [];
    for (const file of FILES) {
      if (isCanaryOwned(file.rel)) continue;
      if (ALLOWED_PROTOTYPE_ASSIGNMENTS.has(file.rel)) continue;
      if (PROTOTYPE_ASSIGNMENT_RE.test(file.content)) violations.push(file.rel);
      PROTOTYPE_ASSIGNMENT_RE.lastIndex = 0;
    }
    expect(violations).toEqual([]);
  });
});

// --- Rule 3: marker/ledger sync ---

const MARKER_RE = /pi-internal\(([a-zA-Z0-9_-]+)\)/g;

function collectMarkerTopics(): Set<string> {
  const topics = new Set<string>();
  for (const file of FILES) {
    for (const match of file.content.matchAll(MARKER_RE)) {
      topics.add(match[1]!);
    }
  }
  return topics;
}

const MARKER_TOPICS = collectMarkerTopics();
const README_CONTENT = readFileSync(README_PATH, "utf-8");

/** Topic column of the "Markers elsewhere" table only (not the couplings table above it). */
function markersElsewhereTopics(readme: string): string[] {
  const start = readme.indexOf("## Markers elsewhere");
  const end = readme.indexOf("## Upgrade checklist");
  expect(start, "README is missing the 'Markers elsewhere' heading").toBeGreaterThanOrEqual(0);
  expect(end, "README is missing the 'Upgrade checklist' heading").toBeGreaterThan(start);
  const section = readme.slice(start, end);
  const topics: string[] = [];
  for (const line of section.split("\n")) {
    const cellMatch = /^\|\s*`([a-zA-Z0-9_-]+)`\s*\|/.exec(line);
    if (cellMatch) topics.push(cellMatch[1]!);
  }
  return topics;
}

describe("boundary: pi-internal marker/ledger sync", () => {
  it("found at least one marker (sanity: the regex isn't silently matching nothing)", () => {
    expect(MARKER_TOPICS.size).toBeGreaterThan(10);
  });

  it.each([...MARKER_TOPICS])("marker topic %s appears in src/pi/README.md", (topic) => {
    expect(README_CONTENT).toContain(topic);
  });

  it("every topic in the ledger's 'Markers elsewhere' table has a real marker in code", () => {
    const listed = markersElsewhereTopics(README_CONTENT);
    expect(listed.length).toBeGreaterThan(10);
    const missing = listed.filter((topic) => !MARKER_TOPICS.has(topic));
    expect(missing).toEqual([]);
  });
});
