// TS-1 (#14): the install check — pack the main package and the host platform
// package, install both into a FRESH project, and prove the SDK loads via
// require AND import, exposes the canonical API, and type-checks a consumer
// snippet with tsc.
//
// This is the issue's regression test: it fails on the pre-TS-1 package
// (unscoped name, no per-platform packages, hand-written local-only loader,
// empty index.d.ts) and must pass on the packed @trueseal/sync artifacts.
//
// What this verifies WITHOUT the npm org (maintainer item A1): tarball
// well-formedness, files lists, per-platform package structure, loader
// resolution of the scoped optional dependency, dual-module loading, and
// type-checking. What it CANNOT verify until A1 + OPS-4 (first publish):
// registry resolution of `@trueseal/sync` + the optional dependency from npm
// itself (G13). That half is marked PACK-LOCAL below.
//
// Usage: node scripts/verify-install.mjs   (after `npm run build`)

import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function fail(msg) {
  console.error(`verify-install: FAIL — ${msg}`)
  process.exit(1)
}

// spawnSync('npm') can't resolve npm.cmd without a shell on Windows.
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts })
  if (r.status !== 0) {
    console.error(r.stdout)
    console.error(r.stderr)
    fail(`\`${cmd} ${args.join(' ')}\` exited ${r.status} (cwd ${opts.cwd ?? process.cwd()})`)
  }
  return r.stdout.trim()
}

// ── Host platform → napi target / platform-package directory ────────────────
const HOSTS = {
  'darwin-arm64': { triple: 'aarch64-apple-darwin', dir: 'darwin-arm64' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', dir: 'darwin-x64' },
  'linux-x64': { triple: 'x86_64-unknown-linux-gnu', dir: 'linux-x64-gnu' },
  'linux-arm64': { triple: 'aarch64-unknown-linux-gnu', dir: 'linux-arm64-gnu' },
  'win32-x64': { triple: 'x86_64-pc-windows-msvc', dir: 'win32-x64-msvc' },
}
const host = HOSTS[`${process.platform}-${process.arch}`]
if (!host) fail(`unsupported host ${process.platform}-${process.arch}`)

// ── 1. Package identity ───────────────────────────────────────────────────────
if (pkg.name !== '@trueseal/sync') fail(`main package name is ${pkg.name}, want @trueseal/sync`)
if (pkg.version !== '0.6.0') fail(`version is ${pkg.version}, want the 0.6.0 lockstep (ADR-0030)`)
const platformPkgName = `@trueseal/sync-${host.dir}`
const optDep = pkg.optionalDependencies?.[platformPkgName]
if (optDep !== '0.6.0') fail(`optionalDependencies["${platformPkgName}"] is ${optDep}, want "0.6.0"`)
const engines = pkg.engines?.node ?? ''
if (!engines.includes('20')) fail(`engines.node is "${engines}", the spec requires Node >= 20`)

const platformDir = join(root, 'npm', host.dir)
if (!existsSync(platformDir)) fail(`per-platform package directory missing: npm/${host.dir}`)
const platformPkg = JSON.parse(readFileSync(join(platformDir, 'package.json'), 'utf8'))
if (platformPkg.name !== platformPkgName) fail(`platform package name is ${platformPkg.name}, want ${platformPkgName}`)
if (platformPkg.version !== '0.6.0') fail(`platform package version is ${platformPkg.version}, want 0.6.0`)

// The native binary must have been built for this host (npm run build).
const binaryName = pkg.napi?.binaryName ?? fail('package.json napi.binaryName missing')
const builtNode = join(root, `${binaryName}.${host.dir}.node`)
if (!existsSync(builtNode)) fail(`built native module missing: ${builtNode} — run \`npm run build\` first`)

const tmp = mkdtempSync(join(tmpdir(), 'trueseal-verify-'))
console.log(`verify-install: staging in ${tmp}`)

// ── 2. Pack the main package ──────────────────────────────────────────────────
const mainTarball = join(tmp, run(npmCmd, ['pack', '--pack-destination', tmp], { cwd: root }).split('\n').pop())

// ── 3. Stage + pack the platform package (binary placed as napi-rs expects) ──
const stagePlatform = join(tmp, 'platform-stage')
mkdirSync(stagePlatform, { recursive: true })
cpSync(platformDir, stagePlatform, { recursive: true })
cpSync(builtNode, join(stagePlatform, `${binaryName}.${host.triple}.node`))
const platformTarball = join(tmp, run(npmCmd, ['pack', '--pack-destination', tmp], { cwd: stagePlatform }).split('\n').pop())

// ── 4. Fresh consumer project; install both tarballs ─────────────────────────
// --no-optional: the optionalDependencies entries name the registry (paused on
// A1); the platform package arrives from its tarball instead. This is the
// PACK-LOCAL half of G13 — registry resolution is the paused half.
const consumer = join(tmp, 'consumer')
mkdirSync(consumer, { recursive: true })
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'verify-consumer', version: '0.0.0', private: true }))
run(npmCmd, ['install', '--no-optional', '--no-audit', '--no-fund', '--ignore-scripts', mainTarball, platformTarball], { cwd: consumer })
const installed = join(consumer, 'node_modules', '@trueseal', 'sync')
if (!existsSync(installed)) fail('main package not installed under node_modules/@trueseal/sync')
const installedPlatform = join(consumer, 'node_modules', '@trueseal', `sync-${host.dir}`)
if (!existsSync(installedPlatform)) fail(`platform package not installed under node_modules/@trueseal/sync-${host.dir}`)

// ── 5. Load via require AND import; probe the canonical surface ──────────────
const probeBody = `
  if (typeof mod.TrueSeal !== 'function') throw new Error('TrueSeal not exported')
  if (typeof mod.TrueSealError !== 'function') throw new Error('TrueSealError not exported')
  const info = mod.TrueSeal.info
  if (info.sdkVersion !== '0.6.0') throw new Error('sdkVersion ' + info.sdkVersion + ' != 0.6.0')
  if (info.transportVersion !== 1 || info.endToEndVersion !== 1) throw new Error('protocol versions wrong: ' + JSON.stringify(info))
  if (mod.TrueSeal.maxPayloadBytes !== 61440) throw new Error('maxPayloadBytes ' + mod.TrueSeal.maxPayloadBytes)
  if (mod.TrueSeal.maxGroupSize !== 32) throw new Error('maxGroupSize ' + mod.TrueSeal.maxGroupSize)
  const parsed = mod.TrueSeal.parseRelayAddress('trueseal://' + 'ab'.repeat(32) + '@relay.example.com')
  if (parsed.host !== 'relay.example.com' || parsed.receivePort !== 7700 || parsed.pushPort !== 7701) {
    throw new Error('parseRelayAddress wrong: ' + JSON.stringify(parsed))
  }
  console.log(KIND + ' load OK — info ' + JSON.stringify(info))
`
writeFileSync(join(consumer, 'probe.cjs'), `const mod = require('@trueseal/sync')
const KIND = 'require'
${probeBody}`)
writeFileSync(join(consumer, 'probe.mjs'), `const mod = await import('@trueseal/sync')
const KIND = 'import'
${probeBody}`)
run(process.execPath, ['probe.cjs'], { cwd: consumer })
run(process.execPath, ['probe.mjs'], { cwd: consumer })

// ── 6. tsc type-checks a consumer snippet against the installed types ────────
writeFileSync(join(consumer, 'consumer.ts'), `
import { TrueSeal, TrueSealError } from '@trueseal/sync'
import type { Member, GroupStatus, TrueSealEvent, DeliveryIssue, RelayAddress, TrueSealOptions } from '@trueseal/sync'

const opts: TrueSealOptions = { storageDir: '/tmp/x', namespace: 'n' }

const status: GroupStatus = 'member'
const m: Member = { id: 'x', name: 'AmberFalcon' }
async function use() {
  const ts = await TrueSeal.open('trueseal://' + 'ab'.repeat(32) + '@localhost', { storageDir: '/tmp/x' })
  const id: string = await ts.send(new Uint8Array([1]))
  const me: Member = ts.me
  ts.onEvent((e: TrueSealEvent) => { void e })
  ts.onDeliveryIssue((i: DeliveryIssue) => { void i })
  ts.close()
  void id; void me
}
function typed(err: unknown) { if (err instanceof TrueSealError) { const code = err.code; void code } }
const addr: RelayAddress = { host: 'h', publicKey: new Uint8Array(32), receivePort: 7700, pushPort: 7701 }
void use; void typed; void status; void m; void addr; void opts
`)
writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2020', module: 'NodeNext', moduleResolution: 'NodeNext',
    strict: true, noEmit: true, skipLibCheck: true,
  },
  include: ['consumer.ts'],
}))
// The repo's own pinned typescript (npx would try the registry).
run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], { cwd: consumer })

console.log('verify-install: PASS — @trueseal/sync packs, installs fresh, loads via require+import, and type-checks')
