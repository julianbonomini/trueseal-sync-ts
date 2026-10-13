// Tests for P5: dispose() / Symbol.dispose cleanup API.
//
// TruesealSyncClient holds TSFNs that are unref()'d, so they won't prevent
// process exit. But users need an explicit teardown path for:
//   - Electron window close / beforeunload
//   - Re-pairing (create fresh client after destroying group)
//   - Preventing stale event handlers firing on a destroyed context
//
// dispose():
//   - closes the core session (ADR-0028 close(): connection, threads and
//     handler stop; Session State kept on disk; every later call throws
//     typed `closed`) — TS-3 wired the real close path
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
const { TruesealSyncClient, TrueSealError } = indexPkg

const RELAY_PUB = Buffer.alloc(32, 0x01)
const TMP = () => mkdtempSync(join(tmpdir(), 'trueseal-p5-test-'))

async function makeClient() {
  return TruesealSyncClient.create({
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

test('calls after dispose throw typed closed (TS-3: dispose really closes)', async () => {
  const client = await makeClient()
  client.dispose()
  // dispose() now calls the core's close() (ADR-0028): the connection, the
  // receive/pump threads and the handler all stop, and every subsequent
  // call fails with typed `closed`. Session State stays on disk.
  for (const read of [() => client.localNodeId, () => client.localDeviceName, () => client.members]) {
    let thrown = null
    try { read() } catch (err) { thrown = err }
    ok(thrown instanceof TrueSealError, `expected TrueSealError, got ${thrown?.constructor?.name}`)
    strictEqual(thrown.code, 'closed')
  }
})
