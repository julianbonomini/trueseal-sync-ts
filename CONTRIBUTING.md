# Contributing

## Release contract (SDK-4 / e2e ADR-0002)

This repo releases as part of the lockstep **TrueSeal Release**: same
version as the core and the other SDKs, promoted only after the Release
Gate passes. Two dispatch-only workflows own the mechanics; pushing a tag
triggers nothing.

**Candidate** — `gh workflow run candidate.yml -f version=X.Y.Z [-f dry_run=true] [-f core_rev=<40-char SHA>]`

- Resolves the core pin: the committed `core-rev.txt` (== the `Cargo.toml`
  `rev =`; CI's pin-guard enforces the equality), or the Release Conductor's
  exact-SHA override. An override changes **which** pinned bytes, never
  **whether** the bytes are pinned (G8).
- Stamps the release commit `release/vX.Y.Z`: the version across all six
  manifests (main + five `npm/*/package.json`) and the optionalDependencies
  pins (`scripts/stamp-version.mjs`), plus the core pin in `Cargo.toml` /
  `core-rev.txt` / `Cargo.lock` (the lock is the checksum).
- Builds, tests and packs on the release commit: the main tarball + five
  per-platform tarballs, plus the G12 parity gate, and stages everything in
  a **draft** GitHub Release `vX.Y.Z` with `trueseal-sync-ts-X.Y.Z-checksums.txt`.
  No tag.

**Promote** — `gh workflow run promote.yml -f version=X.Y.Z`

- Idempotent: an already-published `vX.Y.Z` is a no-op success.
- Refuses to touch a tag that exists out of band while the release is a
  draft (tags are immutable — ADR-0030).
- Re-verifies the staged tarballs against the staged checksums manifest AND
  the release commit's stamps + core pin, then publishes the draft —
  creating the immutable tag on the release commit. Same bytes, no rebuild.

**npm registry publish** is not a workflow step: the first publish of each
package is OPS-4 (maintainer), then npm switches to trusted publishing
(needs the `trueseal` org, maintainer item A1). The GitHub Release carries
the exact tarballs npm will receive; the OPS-4 seam is documented in
`promote.yml`.

**G12 parity** — `scripts/check-parity.mjs` compares the compiled runtime
vocabularies against `Parity/shared-facts.json`, a SHA-256-pinned vendored
copy of the core's generated Shared Facts (see `Parity/README.md` for the
pin and how to re-pin deliberately). It runs on every PR with a self-test
negative control, and its report artifact (`trueseal-g12-parity-report`) is
Release Evidence for the Conductor.

## What the Release Conductor (E2E-8) consumes

- Dispatches `candidate.yml` with `version` and optionally `core_rev` (the
  core candidate's commit, so the gate tests the exact combination users
  install — ADR-0002 step 3).
- Reads the staged draft release `vX.Y.Z`: six tarballs + the checksums
  manifest for the Release Manifest.
- Attaches the `trueseal-g12-parity-report` workflow artifact (and the
  per-leg `g5-vector-report-*` artifacts from ci.yml) as Release Evidence.
- Dispatches `promote.yml` with `version` after a green gate.

## CI layout

- `ci.yml` — every PR: audit, pin-guard (core pin equality + no sibling
  path + no floating refs), **parity** (G12), the 8-leg build+test matrix
  with install verification and G5 vector reports, and the linux-arm64
  cross-build leg.
- `candidate.yml` / `promote.yml` — dispatch-only; see above.

## Running the tests

Unit tests run without a relay:

```bash
npm test
```

The relay-backed smoke tests (full pairing flow) need a local relay:

```bash
cd ../trueseal-relay && TRUESEAL_RELAY_KEYPAIR_PATH=/tmp/relay/keypair.hex TRUESEAL_RELAY_STORE_SQLITE_PATH=/tmp/relay/inbox.db ./trueseal-relay
RELAY_PUB_KEY=<64-hex> npm test   # the relay's `pubkey` command prints it
SKIP_RELAY_TESTS=1 npm test        # skip the smoke tests
```
