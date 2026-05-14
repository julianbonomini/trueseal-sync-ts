// Tests for P4: destroyGroup(), cancelPairing(), acceptPairingRequest() must
// wrap native errors as HushSyncError, not let raw NAPI Error objects leak.
//
// We verify this by monkey-patching the private _session to throw, then
// asserting the public method throws a HushSyncError.

import { ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

import indexPkg from '../dist/index.js'
const { HushSyncClient, HushSyncError } = indexPkg

const RELAY_PUB = Buffer.alloc(32, 0x01)
const TMP = () => mkdtempSync(join(tmpdir(), 'hush-p4-test-'))

async function makeClient() {
  return HushSyncClient.create({
    relayHost: '127.0.0.1',
    relayPublicKey: RELAY_PUB,
    storageDir: TMP(),
    namespace: 'p4',
  })
}

// Inject a fake _session method that throws a raw Error (simulating a native throw).
function injectThrow(client, methodName) {
  const realSession = client._session
  const fake = Object.create(realSession)
  fake[methodName] = () => { throw new Error(`native ${methodName} failed`) }
  // Bypass private field via property override
  Object.defineProperty(client, '_session', { value: fake, writable: true, configurable: true })
}

// ── destroyGroup ──────────────────────────────────────────────────────────────

test('destroyGroup: native throw surfaces as HushSyncError', async () => {
  const client = await makeClient()
  injectThrow(client, 'destroyGroup')
  let thrown = null
  try {
    client.destroyGroup()
  } catch (err) {
    thrown = err
  }
  ok(thrown !== null, 'must throw')
  ok(thrown instanceof HushSyncError, `expected HushSyncError, got ${thrown?.constructor?.name}`)
  strictEqual(thrown.name, 'HushSyncError')
})

// ── cancelPairing ─────────────────────────────────────────────────────────────

test('cancelPairing: native throw surfaces as HushSyncError', async () => {
  const client = await makeClient()
  injectThrow(client, 'cancelPairing')
  let thrown = null
  try {
    client.cancelPairing()
  } catch (err) {
    thrown = err
  }
  ok(thrown !== null, 'must throw')
  ok(thrown instanceof HushSyncError, `expected HushSyncError, got ${thrown?.constructor?.name}`)
})

// ── acceptPairingRequest ──────────────────────────────────────────────────────

test('acceptPairingRequest: native throw surfaces as HushSyncError', async () => {
  const client = await makeClient()
  injectThrow(client, 'acceptMember')
  let thrown = null
  try {
    client.acceptPairingRequest('bad-token')
  } catch (err) {
    thrown = err
  }
  ok(thrown !== null, 'must throw')
  ok(thrown instanceof HushSyncError, `expected HushSyncError, got ${thrown?.constructor?.name}`)
})

// ── Happy paths still work ────────────────────────────────────────────────────

test('cancelPairing: does not throw normally', async () => {
  const client = await makeClient()
  client.cancelPairing()  // must not throw
})

test('acceptPairingRequest: returns false for unknown token (no throw)', async () => {
  const client = await makeClient()
  // Calling with any token when no pairing window is open should return false,
  // not throw — this validates the happy path still works.
  const result = client.acceptPairingRequest('some-token')
  ok(typeof result === 'boolean', 'returns boolean')
})
