#!/usr/bin/env node
// SDK-3 (#11): no version or protocol-limit literal is hand-written in SDK
// sources. TrueSeal.info / maxPayloadBytes / maxGroupSize are pass-throughs
// from the linked core (src/index.ts reads the NAPI constants), so a
// hand-typed 61440 / 65519 / sdkVersion in the SDK would be a drift bug by
// construction. This guard fails the build on one; the suite pins the actual
// values against the ADRs (__tests__/generated-info.test.mjs), and the
// generated files (index.js loader, index.d.ts, dist/) are exempt — they ARE
// the core's surface. Mirrors the Kotlin SDK-3 guard (kotlin#15) and the
// Swift grep (swift#12), with TS syntax covered: numeric separators
// (61_440), hex (0xF000 / 0xFFEF) and template-literal assignments.
//
// Usage: node scripts/check-no-literal-limits.mjs [--dir <path>]
//   --dir overrides the scan root (the negative tests point it at fixtures).

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argDir = process.argv.indexOf('--dir')
const SCAN_ROOT = argDir !== -1 ? process.argv[argDir + 1] : join(REPO_ROOT, 'src')

// The numeric limits, in every spelling TypeScript accepts. (61,440 = 0xF000;
// 65,519 = 0xFFEF is the u16 frame ceiling behind it, ADR-0025/NOISE-4.)
const LIMIT_LITERAL = /61440|61_440|0x[Ff]000|65519|65_519|0x[Ff][Ff][Ee][Ff]/
// A version-literal ASSIGNMENT is a drift bug (a type annotation like
// `transportVersion: number` is not — the value side must be a literal).
const VERSION_STRING_ASSIGN = /(?:sdkVersion|transportVersion|endToEndVersion)\s*[:=]\s*['"`]/
const VERSION_NUMBER_ASSIGN = /(?:transportVersion|endToEndVersion)\s*[:=]\s*\d/

let fail = 0

function checkTs(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const at = `${file}:${i + 1}`
    if (LIMIT_LITERAL.test(line)) {
      console.error(`ERROR: a protocol-limit literal in hand-written SDK sources — read it from the core (TrueSeal.maxPayloadBytes)\n  ${at}`)
      fail = 1
    }
    if (VERSION_STRING_ASSIGN.test(line)) {
      console.error(`ERROR: a version literal assigned in hand-written SDK sources — read it from the core (TrueSeal.info)\n  ${at}`)
      fail = 1
    }
    if (VERSION_NUMBER_ASSIGN.test(line)) {
      console.error(`ERROR: a numeric protocol-version assignment in hand-written SDK sources — read it from the core (TrueSeal.info)\n  ${at}`)
      fail = 1
    }
  })
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name.endsWith('.ts')) checkTs(p)
  }
}
walk(SCAN_ROOT)

// The README must not restate the numeric limits (it may name the API or
// link the docs). Checked at the repo root only, not under --dir fixtures.
if (argDir === -1) {
  const readme = join(REPO_ROOT, 'README.md')
  if (existsSync(readme)) {
    const lines = readFileSync(readme, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/\b61,?440\b|\b65,?519\b/.test(line)) {
        console.error(`ERROR: a protocol-limit literal in the README — name TrueSeal.maxPayloadBytes or link the docs page instead\n  README.md:${i + 1}`)
        fail = 1
      }
    })
  }
}

if (fail !== 0) process.exit(1)
console.log('check-no-literal-limits: clean')
