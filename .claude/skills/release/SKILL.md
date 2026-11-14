---
name: release
description: Cut a new release of grit following the repo's develop/main branching and Keep-a-Changelog conventions. Use when the user asks to "release", "cut a release", "ship a new version", "bump the version", "publish a release", or "tag a release". Syncs develop/main, bumps the version in package.json, Cargo.toml and tauri.conf.json, finalizes CHANGELOG.md, distills it into the in-app CHANGELOG.app.md, merges develop into main, tags it, waits for the Release workflow to build the installers into a draft GitHub Release, and publishes it.
---

# Cut a grit release

grit ships releases by merging `develop` into `main` and tagging the merge with `vX.Y.Z`.
Pushing the tag starts the **Release** workflow (`.github/workflows/release.yml`), which checks that
the tag matches the app version, builds installers for macOS (Apple Silicon and Intel), Linux and
Windows, and attaches them to a **draft** GitHub Release whose notes are the matching
`CHANGELOG.md` section. The release is only public once that draft is published.

Pushing `main` also refreshes the rolling **Latest main build** pre-release (tag `main-build`) after
CI passes. That happens automatically and is not part of this workflow, but it means pushing `main`
publishes installers too.

Follow the steps in order. This touches `main`, pushes a tag and publishes installers, so
**confirm the version and pause before pushing** (step 7) **and before publishing** (step 9).
Don't push or publish without the user's go-ahead.

## Conventions

- The version lives in **three files** that must agree (CI fails otherwise, see
  `.github/scripts/check-version.mjs`):
  - `package.json` → `"version"`
  - `src-tauri/Cargo.toml` → `[package] version` (plus the matching `grit` entry in `src-tauri/Cargo.lock`)
  - `src-tauri/tauri.conf.json` → `"version"`
- SemVer, currently `0.x`.
- Commit messages follow the repo style (imperative, no emoji, no prefix):
  - prepare commit on `develop`: `Prepare X.Y.Z release`
  - merge commit on `main`: `Release X.Y.Z (merge develop)` (a `--no-ff` merge)
- The tag is **annotated**, named `vX.Y.Z`, message `Release X.Y.Z`, on the merge commit.
  Tags with a `-` (e.g. `v0.2.0-beta.1`) become pre-releases automatically.
- `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): the
  `## [Unreleased]` section rolls into `## [X.Y.Z] - YYYY-MM-DD`, and link definitions live at the
  bottom of the file. `.github/scripts/changelog-section.mjs` extracts a section for the release
  notes, so keep the heading format exact.
- `CHANGELOG.app.md` is the **user-facing changelog** shown in the app's About dialog (imported
  raw and rendered as markdown by `src/components/AboutDialog.tsx`, which also shows the version
  from `package.json`). It is a compressed version of `CHANGELOG.md`: released versions only, a
  few user-facing bullets each, newest first. It gets its new section in the prepare commit
  (step 4). Raw HTML is not rendered, so the maintainer comment at the top stays hidden.

## Workflow

### 1. Sync develop and main

```bash
git fetch origin --prune --tags
git checkout develop && git pull --ff-only origin develop
git checkout main    && git pull --ff-only origin main
git checkout develop
```

Confirm the working tree is clean (untracked local files like `.claude/` aside) and that everything
meant for this release is merged into `develop`. If a PR is still meant to be in the release, stop
and say so.

### 2. Decide the new version

Find the previous release: `git describe --tags --abbrev=0 --match 'v[0-9]*' main` (ignore
`main-build`). Let `PREV` be that version without the `v`.

**First release:** if there is no `v*` tag yet, there is no `PREV`. Propose releasing the version
already in the files (currently `0.1.0`) as-is, without a bump.

Otherwise read the `## [Unreleased]` section of `CHANGELOG.md`, propose a SemVer bump, and
**confirm with the user** (don't pick silently):

- Breaking changes → major. Pre-1.0, a breaking change is usually still a **minor** bump; flag it and let the user decide.
- New features (an `### Added` / `### Changed` section) → **minor**.
- Only fixes (`### Fixed`) → **patch**.

If `## [Unreleased]` is empty, there is nothing to release; stop and say so.

Let `NEXT` be the agreed version.

### 3. Pre-flight gates

Run the same checks as CI and require all to pass:

```bash
npm run typecheck && npm test && npm run build
(cd src-tauri && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked)
```

Also check that CI on `develop` is green for the commit being released:
`gh run list --branch develop --workflow CI --limit 1`.

### 4. Prepare the release on `develop`

On `develop`, make one `Prepare NEXT release` commit that does all three:

1. **Set the version to `NEXT`** in `package.json`, `src-tauri/Cargo.toml` and
   `src-tauri/tauri.conf.json` (skip if it is already `NEXT`, e.g. on the first release). Then
   update the lockfiles and verify:

   ```bash
   npm install --package-lock-only
   (cd src-tauri && cargo update --workspace --offline)
   node .github/scripts/check-version.mjs vNEXT
   ```

   Only the `grit` entries in `package-lock.json` and `src-tauri/Cargo.lock` should change; if
   other dependencies moved, revert that and investigate.

2. **Finalize `CHANGELOG.md`:**
   - Rename `## [Unreleased]` to `## [NEXT] - YYYY-MM-DD` (today's date).
   - Insert a fresh, empty `## [Unreleased]` above it.
   - Update the link definitions at the bottom:
     - `[Unreleased]: https://github.com/sraesch/grit/compare/vNEXT...HEAD`
     - add `[NEXT]: https://github.com/sraesch/grit/compare/vPREV...vNEXT` above the `[PREV]` line,
       or on the first release `[NEXT]: https://github.com/sraesch/grit/releases/tag/vNEXT`
   - Tidy the entries if needed (merge duplicates, user-facing wording), but don't drop anything
     without asking.

   Check the notes the Release workflow will use:
   `node .github/scripts/changelog-section.mjs NEXT`.

3. **Update `CHANGELOG.app.md`** (the in-app changelog): add a `## NEXT — YYYY-MM-DD` section
   at the top, directly below the `# What's new` heading, distilled from the section you just
   finalized in `CHANGELOG.md`. Follow the rules in the file's header comment:
   - **Concise**: about 3–6 bullets, one line each, covering what a user would notice, most
     important first. Merge related entries into one; drop purely internal ones (CI, release
     workflow, Dependabot, tests, refactors, license, build tooling) unless they change
     something the user can see or feel.
   - **Self-contained**: no links, no references to files, issues, PRs, commits or docs. The
     text must stand on its own inside the app.
   - **User language**: describe what changed for the user, not how it was implemented
     ("Faster history loading for large repositories", not "Virtualized commit list").
   - Released versions only: no `Unreleased` section, no Keep-a-Changelog preamble, no link
     definitions, no `### Added`/`### Fixed` subsections. Older sections stay as they are.

   If the file is missing, recreate it with this header and then add the section:

   ```markdown
   <!--
   In-app changelog, shown to users in grit's About dialog. Compressed from CHANGELOG.md at release time.
   Rules: released versions only, newest first, heading "## X.Y.Z — YYYY-MM-DD";
   a few short user-facing bullets per version, most important first; no links or references
   to files, issues or PRs; describe what changed for the user, not how; leave out internal
   changes (CI, tests, tooling, refactors).
   -->

   # What's new
   ```

   Show the distilled section and the release notes from step 2 to the user together with the
   version confirmation.

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json CHANGELOG.md CHANGELOG.app.md
git commit -m "Prepare NEXT release"
```

Don't push yet; everything is pushed together in step 7.

### 5. Merge develop into main

`main` only ever gets `--no-ff` release merges:

```bash
git checkout main
git merge --no-ff develop -m "Release NEXT (merge develop)"
```

If the merge conflicts, `main` has diverged unexpectedly; stop and investigate rather than forcing it.

### 6. Tag the merge

Annotated tag on the merge commit:

```bash
git tag -a vNEXT -m "Release NEXT"
```

### 7. Push (confirm first)

Show the user what will be pushed (`git log --oneline origin/main..main`, the tag) and get their
go-ahead, then:

```bash
git push origin develop
git push origin main
git push origin vNEXT
```

The tag push starts the Release workflow for `vNEXT`; the `main` push runs CI and then refreshes the
Latest main build.

### 8. Wait for the installers

Watch the Release run for the tag until all build jobs finish:

```bash
gh run list --workflow Release --event push --limit 3
gh run watch <run-id> --exit-status
```

The builds take a while (four platforms). If a job fails, report which one and why
(`gh run view <run-id> --log-failed`); don't publish a release with missing installers unless the
user says so. A failed job can be retried with `gh run rerun <run-id> --failed`.

Then check the draft: `gh release view vNEXT`. It should have the changelog notes and installers
for every platform (`.dmg`/`.app.tar.gz` for both macOS targets, `.deb`/`.rpm`/`.AppImage`,
`.msi`/`.exe`).

### 9. Publish the release (confirm first)

With the user's go-ahead:

```bash
gh release edit vNEXT --draft=false --latest
```

For a pre-release tag (with a `-`), leave out `--latest`; the workflow already marked it as a
pre-release.

### 10. Wrap up

- Return to `develop`: `git checkout develop`.
- Confirm CI on `main` is green and the Latest main build was refreshed.
- Report to the user: the version, the release URL, the installers attached, and the CI status.
  Remind them that the installers are unsigned until signing secrets are configured.

## Done when

- [ ] `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and the lockfiles are at `NEXT`.
- [ ] `CHANGELOG.md` has a dated `## [NEXT]` section, a fresh empty `## [Unreleased]`, and updated links.
- [ ] `CHANGELOG.app.md` has a distilled, self-contained `## NEXT` section at the top.
- [ ] `develop` is pushed with the prepare commit; `main` has the `--no-ff` release merge.
- [ ] Annotated tag `vNEXT` is pushed.
- [ ] The Release workflow succeeded for every platform and the GitHub Release is published with the changelog notes.
- [ ] CI on `main` is green.
