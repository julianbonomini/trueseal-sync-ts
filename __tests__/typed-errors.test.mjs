// The typed error surface against the REAL core.
//
// Every test here triggers an actual core error through the public API and
// asserts its canonical `code` (and typed extras where the case carries
// them). All reachable without a relay; the codes that require group or
// store state (alreadyInGroup, groupFull, memberNotFound, storage,
// storeTooNew, manifestVersionExhausted) are covered through the bindings
// by the e2e harness — the exhaustiveness GUARD is what protects them here:
//
//   - The Rust mapping is an exhaustive match over the core's 14-variant
//     TrueSealError with NO wildcard: a 15th core variant fails the native
//     build. Nothing stringly-typed exists to drift.
//   - `TRUESEAL_ERROR_CODES` is pinned literal-for-literal below, in
//     shared-facts.json order — the G12 parity check compares this list
//     across the three SDKs.

import { ok, strictEqual, deepStrictEqual } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

import indexPkg from '../dist/index.js'
const { TrueSeal, TrueSealError, TRUESEAL_ERROR_CODES } = indexPkg

const KEY_HEX = Buffer.alloc(32, 0x01).toString('hex')
const ADDRESS = `trueseal://${KEY_HEX}@127.0.0.1`
const TMP = () => mkdtempSync(join(tmpdir(), 'trueseal-typed-'))

async function open(namespace = 'typed') {
  return TrueSeal.open(ADDRESS, { storageDir: TMP(), namespace })
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

test('open() with a malformed Relay Address: invalidRelayAddress', async () => {
  await TrueSeal.open('not a relay address', { storageDir: TMP() }).then(
    () => ok(false, 'must reject'),
    (err) => {
      ok(err instanceof TrueSealError)
      strictEqual(err.code, 'invalidRelayAddress')
    },
  )
})

// ── invalidNamespace ──────────────────────────────────────────────────────────

test('open() with an illegal namespace: invalidNamespace', async () => {
  await TrueSeal.open(ADDRESS, { storageDir: TMP(), namespace: 'bad namespace!' }).then(
    () => ok(false, 'must reject'),
    (err) => {
      ok(err instanceof TrueSealError)
      strictEqual(err.code, 'invalidNamespace')
    },
  )
})

// ── notMember (typed status extra) ────────────────────────────────────────────

test('send() while not a member: notMember carrying status', async () => {
  const ts = await open()
  try {
    ts.send(Buffer.from('x'))
    ok(false, 'must throw')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'notMember')
    strictEqual(err.status, 'notJoined')
  }
  ts.close()
})

// ── payloadTooLarge (typed max extra) ─────────────────────────────────────────

test('send() over the Protocol Size Limit: payloadTooLarge with max 61440', async () => {
  const ts = await open()
  try {
    ts.send(Buffer.alloc(61441))
    ok(false, 'must throw')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'payloadTooLarge')
    strictEqual(err.max, 61440)
  }
  ts.close()
})

// ── messageHandlerAlreadySet ──────────────────────────────────────────────────

test('a second onMessage: messageHandlerAlreadySet', async () => {
  const ts = await open()
  ts.onMessage(() => {})
  try {
    ts.onMessage(() => {})
    ok(false, 'must throw')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'messageHandlerAlreadySet')
  }
  ts.close()
})

// ── invalidPairingToken ───────────────────────────────────────────────────────

test('join() with a malformed token: invalidPairingToken', async () => {
  const ts = await open()
  try {
    ts.join('%%not-a-token%%')
    ok(false, 'must throw')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'invalidPairingToken')
  }
  ts.close()
})

// ── pairingClosed ─────────────────────────────────────────────────────────────

test('accept() with an unknown request id: pairingClosed', async () => {
  const ts = await open()
  ts.startPairing()
  try {
    ts.accept('unknown-request-id')
    ok(false, 'must throw')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'pairingClosed')
  }
  ts.cancelPairing()
  ts.close()
})

// ── closed ────────────────────────────────────────────────────────────────────

test('calls after close(): typed closed', async () => {
  const ts = await open()
  ts.close()
  try {
    ts.send(Buffer.from('x'))
    ok(false, 'must throw')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'closed')
  }
})
