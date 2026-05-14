// Tests for P5: dispose() / Symbol.dispose cleanup API.
//
// HushSyncClient holds TSFNs that are unref()'d, so they won't prevent
// process exit. But users need an explicit teardown path for:
//   - Electron window close / beforeunload
//   - Re-pairing (create fresh client after destroying group)
//   - Preventing stale event handlers firing on a destroyed context
//
// dispose():
//   - removes all EventEmitter listeners (no more callbacks fire)
//   - sets client.disposed = true
//   - is idempotent (safe to call multiple times)
//   - is aliased to [Symbol.dispose] for the `using` keyword

import { ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

import indexPkg from '../dist/index.js'
const { HushSyncClient } = indexPkg

const RELAY_PUB = Buffer.alloc(32, 0x01)
const TMP = () => mkdtempSync(join(tmpdir(), 'hush-p5-test-'))

async function makeClient() {
  return HushSyncClient.create({
    relayHost: '127.0.0.1',
    relayPublicKey: RELAY_PUB,
    storageDir: TMP(),
    namespace: 'p5',
  })
}

// ── disposed getter ───────────────────────────────────────────────────────────

test('disposed is false on a fresh client', async () => {
  const client = await makeClient()
  strictEqual(client.disposed, false)
})

// ── dispose() ─────────────────────────────────────────────────────────────────

test('dispose() sets disposed to true', async () => {
  const client = await makeClient()
  client.dispose()
  strictEqual(client.disposed, true)
})

test('dispose() removes all EventEmitter listeners', async () => {
  const client = await makeClient()
  client.on('message', () => {})
  client.on('connectionChanged', () => {})
  ok(client.listenerCount('message') > 0, 'has listeners before dispose')
  client.dispose()
  strictEqual(client.listenerCount('message'), 0, 'no listeners after dispose')
  strictEqual(client.listenerCount('connectionChanged'), 0, 'no listeners after dispose')
})

test('dispose() is idempotent — safe to call multiple times', async () => {
  const client = await makeClient()
  client.dispose()
  client.dispose()  // must not throw
  strictEqual(client.disposed, true)
})

// ── [Symbol.dispose] ──────────────────────────────────────────────────────────

test('[Symbol.dispose] is present and aliased to dispose()', async () => {
  const client = await makeClient()
  ok(typeof client[Symbol.dispose] === 'function', 'Symbol.dispose exists')
})

test('[Symbol.dispose]() sets disposed = true', async () => {
  const client = await makeClient()
  client[Symbol.dispose]()
  strictEqual(client.disposed, true)
})

// ── Post-dispose safety ───────────────────────────────────────────────────────

test('identity getters still work after dispose', async () => {
  const client = await makeClient()
  client.dispose()
  // Read-only getters should not throw — session data is still accessible.
  ok(typeof client.localNodeId === 'string')
  ok(typeof client.localDeviceName === 'string')
})
