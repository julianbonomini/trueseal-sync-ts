// TS-3: error-surface semantics.
//
// Two rules, both verified here with injected failures:
//   1. A native error carrying a canonical code is rethrown as a typed
//      TrueSealError (code + typed extras preserved).
//   2. Anything else propagates UNCHANGED. There is no catch-all: an
//      unexpected native failure is a bug, and wrapping it in a typed
//      error would be a lie. (The pre-TS-3 tests asserted the opposite —
//      everything was stringified into TruesealSyncError.)

import { ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

import indexPkg from '../dist/index.js'
const { TruesealSyncClient, TrueSealError } = indexPkg

const RELAY_PUB = Buffer.alloc(32, 0x01)
const TMP = () => mkdtempSync(join(tmpdir(), 'trueseal-ts3-test-'))

async function makeClient() {
  return TruesealSyncClient.create({
    relayHost: '127.0.0.1',
    relayPublicKey: RELAY_PUB,
    storageDir: TMP(),
    namespace: 'ts3',
  })
}

// Inject a fake _session method that throws the given value (simulating a
// native throw).
function injectThrow(client, methodName, thrown) {
  const realSession = client._session
  const fake = Object.create(realSession)
  fake[methodName] = () => { throw thrown }
  // Bypass private field via property override
  Object.defineProperty(client, '_session', { value: fake, writable: true, configurable: true })
}

// A native-style typed error: code property + typed extras, like session.rs
// builds them.
function nativeTypedError(code, message, extras = {}) {
  const err = new Error(message)
  err.code = code
  Object.assign(err, extras)
  return err
}

// ── Rule 1: canonical codes become typed TrueSealError ───────────────────────

test('a native error with a canonical code surfaces as TrueSealError', async () => {
  const client = await makeClient()
  injectThrow(client, 'destroyGroup', nativeTypedError('storage', 'storage failure: disk full'))
  let thrown = null
  try {
    client.destroyGroup()
  } catch (err) {
    thrown = err
  }
  ok(thrown instanceof TrueSealError, `expected TrueSealError, got ${thrown?.constructor?.name}`)
  strictEqual(thrown.code, 'storage')
  strictEqual(thrown.name, 'TrueSealError')
  strictEqual(thrown.message, 'storage failure: disk full')
})

test('typed extras survive the rethrow', async () => {
  const client = await makeClient()
  injectThrow(client, 'acceptMember', nativeTypedError('notMember', 'not a member', { status: 'leaving' }))
  let thrown = null
  try {
    client.acceptPairingRequest('req-1')
  } catch (err) {
    thrown = err
  }
  ok(thrown instanceof TrueSealError)
  strictEqual(thrown.code, 'notMember')
  strictEqual(thrown.status, 'leaving')
})

// ── Rule 2: no catch-all — unknown failures propagate unchanged ───────────────

test('a raw native error (no code) propagates unchanged — never wrapped', async () => {
  const client = await makeClient()
  const raw = new Error('native cancelPairing failed')
  injectThrow(client, 'cancelPairing', raw)
  let thrown = null
  try {
    client.cancelPairing()
  } catch (err) {
    thrown = err
  }
  strictEqual(thrown, raw, 'the exact original error object must propagate')
  ok(!(thrown instanceof TrueSealError), 'must NOT be wrapped in a catch-all')
})

test('an unknown code string is NOT treated as a TrueSealError', async () => {
  const client = await makeClient()
  const raw = nativeTypedError('somethingNewTheSdkDoesNotKnow', 'future error')
  injectThrow(client, 'removeMember', raw)
  let thrown = null
  try {
    client.removeMember('m1')
  } catch (err) {
    thrown = err
  }
  strictEqual(thrown, raw, 'unknown codes propagate unchanged (no catch-all)')
})

// ── Happy paths still work ────────────────────────────────────────────────────

test('cancelPairing: does not throw normally', async () => {
  const client = await makeClient()
  client.cancelPairing() // must not throw
})

test('acceptPairingRequest: unknown request throws typed pairingClosed', async () => {
  const client = await makeClient()
  // Canonical semantics (ADR-0023/0028): an unknown request id IS an error —
  // the pre-TS-3 boolean `false` return is gone.
  let thrown = null
  try {
    client.acceptPairingRequest('some-unknown-id')
  } catch (err) {
    thrown = err
  }
  ok(thrown instanceof TrueSealError, `expected TrueSealError, got ${thrown?.constructor?.name}`)
  strictEqual(thrown.code, 'pairingClosed')
})
