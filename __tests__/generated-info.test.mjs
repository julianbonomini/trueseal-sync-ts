// SDK-3 (#11): TrueSeal.info and the limit constants are GENERATED from the
// core — provenance, the ADR alarm, and the literal-ban guard's negative
// tests. The provenance half compares the public statics against the raw
// NAPI values from the linked core, so a pass-through that transforms or
// drifts fails here; the ADR alarm fails if the CORE's values ever move off
// the spec numbers (both halves matter: provenance catches SDK drift, the
// alarm catches an un-announced core change). Mirrors Swift #12 / Kotlin #15.

import { deepStrictEqual, strictEqual, ok } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import indexPkg from '../dist/index.js'
const { TrueSeal } = indexPkg

// The generated loader re-exports the raw NAPI functions — the same
// functions src/index.ts's statics call.
const require = createRequire(import.meta.url)
const native = require('../index.js')

// ── Provenance: the public statics ARE the linked core's values ─────────────

test('TrueSeal.info is the core truesealInfo() value, untransformed', () => {
  deepStrictEqual(TrueSeal.info, native.truesealInfo())
  deepStrictEqual(Object.keys(TrueSeal.info).sort(), [
    'endToEndVersion',
    'sdkVersion',
    'transportVersion',
  ])
})

test('the limit statics are the core constants, untransformed', () => {
  strictEqual(TrueSeal.maxPayloadBytes, native.truesealMaxPayloadBytes())
  strictEqual(TrueSeal.maxGroupSize, native.truesealMaxGroupSize())
})

// ── ADR alarm: the linked core still speaks the spec numbers ────────────────

test('ADR alarm: the values match ADR-0022/0025/0027/0030', () => {
  // ADR-0022: both protocol versions are fixed at 1 for the preview.
  strictEqual(TrueSeal.info.transportVersion, 1)
  strictEqual(TrueSeal.info.endToEndVersion, 1)
  // ADR-0025: the Protocol Size Limit.
  strictEqual(TrueSeal.maxPayloadBytes, 61440)
  // ADR-0027: the Maximum Group Size.
  strictEqual(TrueSeal.maxGroupSize, 32)
  // ADR-0030: the lockstep TrueSeal Release version (exact value pinned in
  // true-seal.test.mjs; here the shape, so a lockstep bump breaks exactly
  // one place).
  ok(/^\d+\.\d+\.\d+$/.test(TrueSeal.info.sdkVersion))
})

// ── The literal-ban guard: negative tests ───────────────────────────────────

// fileURLToPath, not URL.pathname — on Windows the latter yields /D:/...
// and the spawned node mangles it into 'D:\D:\...'.
const GUARD = fileURLToPath(new URL('../scripts/check-no-literal-limits.mjs', import.meta.url))

function runGuard(dir) {
  try {
    execFileSync(process.execPath, [GUARD, '--dir', dir], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, output: '' }
  } catch (err) {
    return { code: err.status, output: String(err.stdout) + String(err.stderr) }
  }
}

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'trueseal-guard-'))
  for (const [name, content] of Object.entries(files)) {
    if (name.includes('/')) mkdirSync(join(dir, name.slice(0, name.lastIndexOf('/'))), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

test('guard: clean sources pass (type annotations and comma-form comments are fine)', () => {
  const dir = fixture({
    'src/index.ts': [
      'export interface TrueSealInfo {',
      '  sdkVersion: string',
      '  transportVersion: number',
      '  endToEndVersion: number',
      '}',
      '// The Protocol Size Limit (61,440 bytes, ADR-0025) comes from the core.',
      'export const x: number = native.truesealMaxPayloadBytes()',
      '',
    ].join('\n'),
  })
  const r = runGuard(dir)
  strictEqual(r.code, 0, r.output)
})

const BAD_FIXTURES = {
  'plain decimal limit': 'export const max = 61440\n',
  'numeric-separator limit': 'export const max = 61_440\n',
  'hex limit': 'export const max = 0xF000\n',
  'hex frame ceiling': 'export const max = 0xffef\n',
  'string version assignment': "const info = { sdkVersion: '0.6.0' }\n",
  'template-literal version assignment': 'const info = { sdkVersion: `0.6.0` }\n',
  'numeric version assignment': 'const info = { transportVersion: 1 }\n',
  'nested file': null, // special-cased below: limit literal in a subdirectory
}

for (const [name, badLine] of Object.entries(BAD_FIXTURES)) {
  test(`guard: rejects ${name}`, () => {
    const dir =
      badLine === null
        ? fixture({ 'src/deep/nested.ts': 'export const max = 65519\n' })
        : fixture({ 'index.ts': badLine })
    const r = runGuard(dir)
    strictEqual(r.code, 1, 'guard must fail')
    ok(r.output.includes('ERROR'), `guard must say why: ${r.output}`)
  })
}
