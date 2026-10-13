// Public entrypoint — the package is '@trueseal/sync' on npm (TS-1, #14);
// these tests verify ESM and CJS resolution of the local package root.
// The fresh-project install shape is scripts/verify-install.mjs.
import { strictEqual, ok } from 'node:assert'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ── CJS require ───────────────────────────────────────────────────────────────

test('CJS require resolves the canonical exports', () => {
  const mod = require('../')   // resolves via package.json "main"
  ok(mod.TrueSeal,            'TrueSeal exported')
  ok(mod.TrueSealError,       'TrueSealError exported')
  ok(mod.RelayAddress,        'RelayAddress exported')
  ok(mod.Subscription,        'Subscription exported')
  ok(mod.TRUESEAL_ERROR_CODES, 'TRUESEAL_ERROR_CODES exported')
  strictEqual(typeof mod.TrueSeal, 'function')
  strictEqual(typeof mod.TrueSealError, 'function')
  // The legacy name is gone outright (ADR-0028 Consequences).
  strictEqual(mod.TruesealSyncClient, undefined)
})

// ── ESM import ────────────────────────────────────────────────────────────────

test('ESM import resolves the canonical exports', async () => {
  // Dynamic import uses package.json "exports"
  const mod = await import('../dist/index.js')
  ok(mod.TrueSeal,      'TrueSeal exported via ESM')
  ok(mod.TrueSealError, 'TrueSealError exported via ESM')
  ok(mod.RelayAddress,  'RelayAddress exported via ESM')
  strictEqual(mod.TruesealSyncClient, undefined)
})

// ── Type exports ──────────────────────────────────────────────────────────────

test('TrueSealError is an Error subclass with a canonical code', () => {
  const { TrueSealError } = require('../')
  const e = new TrueSealError('closed', 'test')
  ok(e instanceof Error)
  ok(e instanceof TrueSealError)
  strictEqual(e.code, 'closed')
  strictEqual(e.name, 'TrueSealError')
})

test('TrueSeal.open and TrueSeal.parseRelayAddress are functions', () => {
  const { TrueSeal } = require('../')
  strictEqual(typeof TrueSeal.open, 'function')
  strictEqual(typeof TrueSeal.parseRelayAddress, 'function')
})
