// RED: public entrypoint — package importable as 'trueseal-sync-ts'
// Tests verify ESM and CJS resolution both work correctly.
import { strictEqual, ok } from 'node:assert'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ── CJS require ───────────────────────────────────────────────────────────────

test('CJS require resolves TruesealSyncClient', () => {
  const mod = require('../')   // resolves via package.json "main"
  ok(mod.TruesealSyncClient, 'TruesealSyncClient exported')
  ok(mod.TruesealSyncError,  'TruesealSyncError exported')
  strictEqual(typeof mod.TruesealSyncClient, 'function')
  strictEqual(typeof mod.TruesealSyncError,  'function')
})

// ── ESM import ────────────────────────────────────────────────────────────────

test('ESM import resolves TruesealSyncClient', async () => {
  // Dynamic import uses package.json "exports"
  const mod = await import('../dist/index.js')
  ok(mod.TruesealSyncClient, 'TruesealSyncClient exported via ESM')
  ok(mod.TruesealSyncError,  'TruesealSyncError exported via ESM')
})

// ── Type exports ──────────────────────────────────────────────────────────────

test('TruesealSyncError is an Error subclass', () => {
  const { TruesealSyncError } = require('../')
  const e = new TruesealSyncError('test')
  ok(e instanceof Error)
  ok(e instanceof TruesealSyncError)
})

test('TruesealSyncClient.create is a function', () => {
  const { TruesealSyncClient } = require('../')
  strictEqual(typeof TruesealSyncClient.create, 'function')
})
