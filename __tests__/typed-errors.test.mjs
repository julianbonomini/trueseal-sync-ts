// TS-3: the typed error surface against the REAL core.
//
// Every test here triggers an actual core error through the public API and
// asserts its canonical `code` (and typed extras where the case carries
// them). All reachable without a relay; the codes that require group or
// store state (alreadyInGroup, groupFull, memberNotFound, storage,
// messageHandlerAlreadySet, storeTooNew, manifestVersionExhausted) are
// covered through the bindings by the e2e harness and the SDK-1 work —
// the exhaustiveness GUARD is what protects them here:
//
//   - The Rust mapping is an exhaustive match over the core's 14-variant
//     TrueSealError with NO wildcard: a 15th core variant fails the native
//     build. Nothing stringly-typed exists to drift.
//   - `TRUESEAL_ERROR_CODES` is pinned literal-for-literal below, in
//     shared-facts.json order — the G12 parity check compares this list
//     across the three SDKs.

import { ok, strictEqual, deepStrictEqual, rejects } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

import indexPkg from '../dist/index.js'
const { TruesealSyncClient, TrueSealError, TRUESEAL_ERROR_CODES } = indexPkg

const RELAY_PUB = Buffer.alloc(32, 0x01)
const TMP = () => mkdtempSync(join(tmpdir(), 'trueseal-typed-'))

async function makeClient(namespace = 'typed') {
  return TruesealSyncClient.create({
    relayHost: '127.0.0.1',
    relayPublicKey: RELAY_PUB,
    storageDir: TMP(),
    namespace,
  })
}

// ── The canonical code list (exhaustiveness guard) ────────────────────────────

test('TRUESEAL_ERROR_CODES is exactly the 14 canonical cases, in shared-facts order', () => {
  deepStrictEqual([...TRUESEAL_ERROR_CODES], [
    'invalidRelayAddress',
    'invalidNamespace',
    'storage',
    'closed',
    'notMember',
    'alreadyInGroup',
    'invalidPairingToken',
    'pairingClosed',
    'groupFull',
    'memberNotFound',
    'payloadTooLarge',
    'messageHandlerAlreadySet',
    'storeTooNew',
    'manifestVersionExhausted',
  ])
})

// ── invalidRelayAddress ───────────────────────────────────────────────────────

test('create() with a wrong-length relay key: invalidRelayAddress', async () => {
  await rejects(
    () => TruesealSyncClient.create({
      relayHost: '127.0.0.1',
      relayPublicKey: Buffer.alloc(16),
      storageDir: TMP(),
    }),
    (err) => {
      ok(err instanceof TrueSealError, `expected TrueSealError, got ${err}`)
      strictEqual(err.code, 'invalidRelayAddress')
      return true
    },
  )
})

test('create() with a malformed authority (a second @): invalidRelayAddress', async () => {
  await rejects(
    () => TruesealSyncClient.create({
      relayHost: 'bad@host',
      relayPublicKey: RELAY_PUB,
      storageDir: TMP(),
    }),
    (err) => {
      ok(err instanceof TrueSealError)
      strictEqual(err.code, 'invalidRelayAddress')
      return true
    },
  )
})

// ── invalidNamespace ──────────────────────────────────────────────────────────

test('create() with an illegal namespace: invalidNamespace', async () => {
  await rejects(
    () => TruesealSyncClient.create({
      relayHost: '127.0.0.1',
      relayPublicKey: RELAY_PUB,
      storageDir: TMP(),
      namespace: 'bad namespace!',
    }),
    (err) => {
      ok(err instanceof TrueSealError)
      strictEqual(err.code, 'invalidNamespace')
      return true
    },
  )
})

// ── notMember (typed status extra) ────────────────────────────────────────────

test('send() before joining: notMember with status notJoined', async () => {
  const client = await makeClient()
  await rejects(
    () => client.send(Buffer.from('hello')),
    (err) => {
      ok(err instanceof TrueSealError)
      strictEqual(err.code, 'notMember')
      strictEqual(err.status, 'notJoined')
      return true
    },
  )
})

// ── payloadTooLarge (typed max extra) ─────────────────────────────────────────

test('send() over the Protocol Size Limit: payloadTooLarge with max 61440', async () => {
  const client = await makeClient()
  // The size check is synchronous and precedes the membership check
  // (ADR-0025), so no group is needed.
  await rejects(
    () => client.send(Buffer.alloc(61_441, 0x61)),
    (err) => {
      ok(err instanceof TrueSealError)
      strictEqual(err.code, 'payloadTooLarge')
      strictEqual(err.max, 61_440)
      return true
    },
  )
})

// ── invalidPairingToken ───────────────────────────────────────────────────────

test('joinGroup() with a garbage token: invalidPairingToken', async () => {
  const client = await makeClient()
  let thrown = null
  try {
    client.joinGroup('not-a-token')
  } catch (err) {
    thrown = err
  }
  ok(thrown instanceof TrueSealError, `expected TrueSealError, got ${thrown}`)
  strictEqual(thrown.code, 'invalidPairingToken')
})

// ── pairingClosed ─────────────────────────────────────────────────────────────

test('acceptPairingRequest() with an unknown request: pairingClosed', async () => {
  const client = await makeClient()
  let thrown = null
  try {
    client.acceptPairingRequest('no-such-request')
  } catch (err) {
    thrown = err
  }
  ok(thrown instanceof TrueSealError)
  strictEqual(thrown.code, 'pairingClosed')
})

// ── closed ────────────────────────────────────────────────────────────────────

test('every call after dispose(): closed', async () => {
  const client = await makeClient()
  client.dispose()
  await rejects(
    () => client.send(Buffer.from('hello')),
    (err) => {
      ok(err instanceof TrueSealError)
      strictEqual(err.code, 'closed')
      return true
    },
  )
  let thrown = null
  try {
    client.pairingToken()
  } catch (err) {
    thrown = err
  }
  ok(thrown instanceof TrueSealError)
  strictEqual(thrown.code, 'closed')
})
