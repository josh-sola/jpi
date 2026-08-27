import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { projectSlug } from "../../src/core/project-slug.ts";

test("projectSlug replaces every path separator with a dash", () => {
  // Nonexistent path: git rev-parse fails with ENOENT, falling back to raw cwd.
  assert.equal(projectSlug("/Users/josh/repos/x"), "-Users-josh-repos-x");
});

test("projectSlug keeps the leading dash from a leading slash", () => {
  assert.equal(projectSlug("/a"), "-a");
});

test("projectSlug on the root path", () => {
  // "/" exists but isn't a repo: git rev-parse exits 128, falling back to raw cwd.
  assert.equal(projectSlug("/"), "-");
});

test("projectSlug dashes characters a Store path segment can't hold", () => {
  assert.equal(projectSlug("/Users/josh/My Repos"), "-Users-josh-My-Repos");
  assert.equal(projectSlug("/Users/josh/repos:x"), "-Users-josh-repos-x");
});

function sanitize(raw: string): string {
  return raw.replace(/\//g, "-").replace(/[^A-Za-z0-9._-]/g, "-");
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("projectSlug resolves worktrees and subdirectories to the main repo root", () => {
  const mainRoot = realpathSync(mkdtempSync(join(tmpdir(), "jpi-project-slug-")));
  const worktreeParent = realpathSync(mkdtempSync(join(tmpdir(), "jpi-project-slug-wt-")));
  const worktreePath = join(worktreeParent, "linked");

  try {
    git(["init"], mainRoot);
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=test",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "init",
      ],
      { cwd: mainRoot, stdio: "ignore" },
    );
    git(["worktree", "add", worktreePath], mainRoot);

    const subdir = join(mainRoot, "src", "nested");
    mkdirSync(subdir, { recursive: true });

    assert.equal(projectSlug(mainRoot), sanitize(mainRoot));
    assert.equal(projectSlug(worktreePath), projectSlug(mainRoot));
    assert.equal(projectSlug(subdir), projectSlug(mainRoot));
  } finally {
    rmSync(worktreeParent, { recursive: true, force: true });
    rmSync(mainRoot, { recursive: true, force: true });
  }
});

test("projectSlug on a plain non-repo temp dir slugs to itself", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "jpi-project-slug-plain-")));
  try {
    assert.equal(projectSlug(dir), sanitize(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
