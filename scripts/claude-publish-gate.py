#!/usr/bin/env python3
"""Protected-path gate for owner `@claude apply` changes (.github/workflows/claude.yml).

Run from the root of a work tree whose changes are about to be published, as
`python3 -I <copy of this file>`: the workflow copies it from the commit it
trusts before the proposed change can touch it, and -I keeps Python from
importing any module a change placed in the working directory. It reads the
changes with `git status`, so staged, unstaged and untracked files all count.

Exit 0: nothing protected changed. Exit 1: refused, with one line per path.

Refused (review 2026-10-13, docs/DECISIONS.md row 219):
- `.github/`: workflows, including this one and the live deploy.
- Claude Code's own configuration and instructions, at any depth: every
  `.claude/` directory (settings, hooks, permissions, skills, agents,
  commands), every `CLAUDE.md` and `CLAUDE.local.md`, and `.mcp.json`. A hook
  committed there would run in every later @claude run, review mode included.
- Credentials and hidden environment: `.env*`, `.dev.vars*`, `.npmrc`,
  `.netrc`, `.gitmodules`.
- The release and deploy gate: scripts that workflow 7 runs with live
  credentials or that decide what the gate tests, `scripts/lib/`, the Wrangler
  configuration and this file.
- The `scripts` of any package.json: npm lifecycle scripts run on `npm ci`,
  and `check`, `test:unit` and `build` define the gate itself.
- Symbolic links (a build can follow one out of the repository and publish
  what it points at) and embedded repositories.

Both ends of a rename count: renaming a protected file away is refused too.
"""
import json
import os
import subprocess
import sys

DEPLOY_GATE = {
    "scripts/apply-remote-migrations.mjs",
    "scripts/check-deploy-freshness.mjs",
    "scripts/check-live-markers.mjs",
    "scripts/check-live-store-slugs.mjs",
    "scripts/check-wrangler-cli.mjs",
    "scripts/claude-publish-gate.py",
    "scripts/live-cost-probes.mjs",
    "scripts/migrate-check.mjs",
    "scripts/prepare-deploy-config.mjs",
    "scripts/purge-zone-cache.mjs",
    "scripts/set-deploy-ids.mjs",
    "scripts/test-all.mjs",
    "scripts/test-no-network.mjs",
    "scripts/write-asset-headers.mjs",
    "wrangler.jsonc",
    "wrangler.json",
    "wrangler.toml",
}
AGENT_FILES = {"claude.md", "claude.local.md", ".mcp.json"}
SECRET_FILES = {".npmrc", ".netrc", ".gitmodules"}


def protected(path):
    parts = [part.lower() for part in path.split("/")]
    base = parts[-1]
    return (
        parts[0] == ".github"
        or ".claude" in parts
        or base in AGENT_FILES
        or base in SECRET_FILES
        or base.startswith(".env")
        or base.startswith(".dev.vars")
        or path in DEPLOY_GATE
        or path.startswith("scripts/lib/")
    )


def git(*args):
    return subprocess.run(["git", *args], check=False, capture_output=True)


def changed_paths():
    result = git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames")
    if result.returncode != 0:
        sys.stderr.write(result.stderr.decode("utf-8", "replace"))
        raise SystemExit("::error::Could not read the proposed changes; refusing to publish.")
    fields = result.stdout.split(b"\0")
    paths = []
    index = 0
    while index < len(fields):
        entry = fields[index]
        index += 1
        if not entry:
            continue
        status = entry[:2]
        paths.append(entry[3:].decode("utf-8", "surrogateescape"))
        # Defensive: a rename or copy entry carries its source path in the next
        # NUL field, and that path must be checked rather than mis-sliced.
        if status[:1] in (b"R", b"C") or status[1:2] in (b"R", b"C"):
            if index < len(fields) and fields[index]:
                paths.append(fields[index].decode("utf-8", "surrogateescape"))
            index += 1
    return paths


def npm_scripts(blob):
    if blob is None:
        return None
    try:
        data = json.loads(blob)
    except ValueError:
        return "unreadable package.json"
    return data.get("scripts") if isinstance(data, dict) else "unreadable package.json"


def package_scripts_changed(path):
    before = git("show", "HEAD:" + path)
    old = before.stdout if before.returncode == 0 else None
    new = None
    if os.path.isfile(path) and not os.path.islink(path):
        with open(path, "rb") as handle:
            new = handle.read()
    return npm_scripts(old) != npm_scripts(new)


def main():
    refusals = []
    for path in changed_paths():
        if path.endswith("/"):
            refusals.append(path + " (embedded repository)")
        elif protected(path):
            refusals.append(path + " (protected workflow, agent, credential or deploy-gate file)")
        elif os.path.islink(path):
            refusals.append(path + " (symbolic link)")
        elif path.split("/")[-1] == "package.json" and package_scripts_changed(path):
            refusals.append(path + " (npm scripts)")
    if refusals:
        print("::error::Refusing to publish protected workflow/instruction/credential files.")
        for line in refusals:
            print("  " + line)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
