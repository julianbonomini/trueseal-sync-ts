// SDK-4 (#12): stamp the release version into every package manifest the
// candidate workflow ships — the main package, the five per-platform
// packages, and the main package's optionalDependencies pins — then sync
// package-lock.json (a version change without a lock sync desyncs the lock's
// root entry and hard-fails `npm ci`; the e2e repo hit exactly this in
// E2E-11).
//
// Versions are exact pins in every direction (ADR-0030 lockstep + G8): the
// main package and its five optional dependencies all carry the SAME X.Y.Z,
// and npm installs the platform package at exactly that version.
//
// Idempotent: stamping the version the manifests already carry is a no-op
// (exit 0, no changes) apart from the lockfile sync, which is itself a no-op
// when the lock already matches.
//
// Usage: node scripts/stamp-version.mjs <X.Y.Z>   (run from the repo root)

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error(`stamp-version: FAIL — version must be X.Y.Z without a v prefix (got '${version}')`)
  process.exit(1)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

// ── 1. The main package ───────────────────────────────────────────────────────
const mainPath = join(root, 'package.json')
const mainPkg = readJson(mainPath)
if (mainPkg.name !== '@trueseal/sync') {
  console.error(`stamp-version: FAIL — main package name is ${mainPkg.name}, want @trueseal/sync`)
  process.exit(1)
}
mainPkg.version = version

// ── 2. The five per-platform packages ────────────────────────────────────────
const npmDir = join(root, 'npm')
const platformDirs = readdirSync(npmDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()
if (platformDirs.length !== 5) {
  console.error(`stamp-version: FAIL — expected 5 platform package dirs under npm/, found ${platformDirs.length}: ${platformDirs}`)
  process.exit(1)
}

const platformNames = []
for (const dir of platformDirs) {
  const path = join(npmDir, dir, 'package.json')
  const pkg = readJson(path)
  const wantName = `@trueseal/sync-${dir}`
  if (pkg.name !== wantName) {
    console.error(`stamp-version: FAIL — npm/${dir}/package.json name is ${pkg.name}, want ${wantName}`)
    process.exit(1)
  }
  pkg.version = version
  writeJson(path, pkg)
  platformNames.push(wantName)
}

// ── 3. The optionalDependencies pins — exact versions, all five, no others ───
const optDeps = mainPkg.optionalDependencies ?? {}
const optNames = Object.keys(optDeps).sort()
if (optNames.length !== 5 || !optNames.every((n, i) => n === platformNames[i])) {
  console.error(`stamp-version: FAIL — optionalDependencies ${JSON.stringify(optNames)} != the platform packages ${JSON.stringify(platformNames)}`)
  process.exit(1)
}
for (const name of optNames) optDeps[name] = version
mainPkg.optionalDependencies = optDeps
writeJson(mainPath, mainPkg)

// ── 4. Sync the lockfile (root entry + workspace-less optional deps) ─────────
const lockPath = join(root, 'package-lock.json')
if (existsSync(lockPath)) {
  const r = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
    cwd: root,
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error('stamp-version: FAIL — npm install --package-lock-only failed')
    process.exit(1)
  }
}

console.log(`stamp-version: stamped ${version} into package.json, npm/{${platformDirs.join(',')}}/package.json, optionalDependencies${existsSync(lockPath) ? ' and package-lock.json' : ''}`)
