// RED: public entrypoint — package importable as 'hush-sync-ts'
// Tests verify ESM and CJS resolution both work correctly.
import { strictEqual, ok } from 'node:assert'
import { test } from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ── CJS require ───────────────────────────────────────────────────────────────

test('CJS require resolves HushSyncClient', () => {
  const mod = require('../')   // resolves via package.json "main"
  ok(mod.HushSyncClient, 'HushSyncClient exported')
  ok(mod.HushSyncError,  'HushSyncError exported')
  strictEqual(typeof mod.HushSyncClient, 'function')
  strictEqual(typeof mod.HushSyncError,  'function')
})

// ── ESM import ────────────────────────────────────────────────────────────────

test('ESM import resolves HushSyncClient', async () => {
  // Dynamic import uses package.json "exports"
  const mod = await import('../dist/index.js')
  ok(mod.HushSyncClient, 'HushSyncClient exported via ESM')
  ok(mod.HushSyncError,  'HushSyncError exported via ESM')
})

// ── Type exports ──────────────────────────────────────────────────────────────

test('HushSyncError is an Error subclass', () => {
  const { HushSyncError } = require('../')
  const e = new HushSyncError('test')
  ok(e instanceof Error)
  ok(e instanceof HushSyncError)
})

test('HushSyncClient.create is a function', () => {
  const { HushSyncClient } = require('../')
  strictEqual(typeof HushSyncClient.create, 'function')
})
