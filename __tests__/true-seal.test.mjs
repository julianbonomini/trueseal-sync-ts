// SDK-1: the canonical TrueSeal public surface.
//
// API-surface conformance, Relay Address parsing, state getters, one-shot
// message-handler semantics, Subscription semantics, close() gating and the
// relay-free slice of the pairing state machine. All relay-free: open()
// points at 127.0.0.1 with nothing listening (the relay connects in the
// background, so open never fails for reachability). The relay-backed
// behaviors live in smoke.test.mjs and the e2e harness.

import { ok, strictEqual, deepStrictEqual, throws } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

import indexPkg from '../dist/index.js'
const { TrueSeal, TrueSealError, RelayAddress, Subscription, TRUESEAL_ERROR_CODES } = indexPkg

const KEY = Buffer.alloc(32, 0x01)
const KEY_HEX = KEY.toString('hex')
const ADDRESS = `trueseal://${KEY_HEX}@127.0.0.1`
const TMP = () => mkdtempSync(join(tmpdir(), 'trueseal-surface-'))

async function open(namespace = 'surface') {
  return TrueSeal.open(ADDRESS, { storageDir: TMP(), namespace })
}

// ── Exports and statics ───────────────────────────────────────────────────────

test('the public type is TrueSeal with the canonical operations', () => {
  strictEqual(typeof TrueSeal, 'function')
  strictEqual(typeof TrueSeal.open, 'function')
  strictEqual(typeof TrueSeal.parseRelayAddress, 'function')
  // The legacy name is gone outright (ADR-0028 Consequences).
  strictEqual(indexPkg.TruesealSyncClient, undefined)
  ok(TrueSealError.prototype instanceof Error)
  ok(Array.isArray(TRUESEAL_ERROR_CODES))
  strictEqual(typeof Subscription, 'function')
})

test('statics come from the core constants (shared-facts.json pinned)', () => {
  deepStrictEqual(TrueSeal.info, {
    sdkVersion: '0.6.0',
    transportVersion: 1,
    endToEndVersion: 1,
  })
  strictEqual(TrueSeal.maxPayloadBytes, 61440)
  strictEqual(TrueSeal.maxGroupSize, 32)
})

// ── Relay Address ─────────────────────────────────────────────────────────────

test('parseRelayAddress: the canonical grammar (defaults, ports, uppercase hex, IPv6)', () => {
  const bare = TrueSeal.parseRelayAddress(`trueseal://${KEY_HEX}@relay.example.com`)
  strictEqual(bare.host, 'relay.example.com')
  ok(bare.publicKey.equals(KEY))
  strictEqual(bare.receivePort, 7700)
  strictEqual(bare.pushPort, 7701)

  const full = TrueSeal.parseRelayAddress(`trueseal://${KEY_HEX}@relay.example.com:8800?push=8801`)
  strictEqual(full.receivePort, 8800)
  strictEqual(full.pushPort, 8801)

  // Uppercase hex is the one lenient superset (ADR-0028 grammar decisions).
  const upper = TrueSeal.parseRelayAddress(`trueseal://${KEY_HEX.toUpperCase()}@relay.example.com`)
  ok(upper.publicKey.equals(KEY))

  // push= alone; IPv6 bracketed.
  strictEqual(TrueSeal.parseRelayAddress(`trueseal://${KEY_HEX}@host?push=9999`).pushPort, 9999)
  strictEqual(TrueSeal.parseRelayAddress(`trueseal://${KEY_HEX}@[::1]:7700?push=7701`).host, '[::1]')
})

test('parseRelayAddress: rejections are typed invalidRelayAddress', () => {
  const bad = [
    `http://${KEY_HEX}@host`,          // wrong scheme
    `${KEY_HEX}@host`,                 // no scheme
    `trueseal://${KEY_HEX.slice(2)}@host`,   // short key
    `trueseal://${KEY_HEX}00@host`,    // long key
    `trueseal://${KEY_HEX}@ho@st`,     // @ in host
    `trueseal://${KEY_HEX}@host?foo=1`,      // unknown query parameter
    `trueseal://${KEY_HEX}@host:abc`,        // non-numeric port
    `trueseal://${KEY_HEX}@host:99999`,      // port out of range
    `trueseal://${KEY_HEX}@host:7700?push=abc`,
    `trueseal://${KEY_HEX}@::1`,             // unbracketed IPv6
  ]
  for (const input of bad) {
    try {
      TrueSeal.parseRelayAddress(input)
      ok(false, `expected invalidRelayAddress for ${input}`)
    } catch (err) {
      ok(err instanceof TrueSealError, `typed error for ${input}`)
      strictEqual(err.code, 'invalidRelayAddress')
    }
  }
})

test('the typed RelayAddress serializes with explicit ports and round-trips', () => {
  const address = new RelayAddress('relay.example.com', KEY, 8800, 8801)
  strictEqual(address.toString(), `trueseal://${KEY_HEX}@relay.example.com:8800?push=8801`)
  const reparsed = TrueSeal.parseRelayAddress(address.toString())
  strictEqual(reparsed.host, address.host)
  ok(reparsed.publicKey.equals(KEY))
  strictEqual(reparsed.receivePort, 8800)
  strictEqual(reparsed.pushPort, 8801)

  // Defaults are explicit in the string form too — the port is never dropped.
  strictEqual(
    new RelayAddress('relay.example.com', KEY).toString(),
    `trueseal://${KEY_HEX}@relay.example.com:7700?push=7701`,
  )
  // IPv6 gets bracketed.
  ok(new RelayAddress('::1', KEY).toString().includes('@[::1]:'))
})

// ── State getters ─────────────────────────────────────────────────────────────

test('state getters have the canonical shapes, fresh from the core', async () => {
  const ts = await open()
  strictEqual(ts.status, 'notJoined')
  const me = ts.me
  strictEqual(typeof me.id, 'string')
  strictEqual(typeof me.name, 'string')
  ok(me.id.length > 0 && me.name.length > 0)
  deepStrictEqual(ts.members, [])
  const connection = ts.connection
  ok(['connecting', 'connected', 'disconnected', 'relayVersionUnsupported'].includes(connection.state))
  ts.close()
})

// ── onMessage: one-shot, awaited, Subscription ────────────────────────────────

test('a second onMessage fails with messageHandlerAlreadySet', async () => {
  const ts = await open()
  ts.onMessage(() => {})
  try {
    ts.onMessage(() => {})
    ok(false, 'second onMessage must throw')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'messageHandlerAlreadySet')
  }
  ts.close()
})

test('cancelling the handler Subscription does NOT re-enable registration (SYNC-15)', async () => {
  const ts = await open()
  const sub = ts.onMessage(() => {})
  sub.cancel()
  sub.cancel() // idempotent
  try {
    ts.onMessage(() => {})
    ok(false, 'registration is one-shot even after cancel')
  } catch (err) {
    strictEqual(err.code, 'messageHandlerAlreadySet')
  }
  ts.close()
})

// ── onEvent / onDeliveryIssue: fan-out and cancel ─────────────────────────────

test('event and issue subscriptions cancel independently and idempotently', async () => {
  const ts = await open()
  const seen = []
  const sub = ts.onEvent((event) => seen.push(event))
  const issueSub = ts.onDeliveryIssue(() => {})
  sub.cancel()
  sub.cancel()
  issueSub.cancel()
  // No delivery after cancel is asserted with real events in the smoke suite;
  // here we assert the mechanics do not throw and the object stays usable.
  strictEqual(ts.status, 'notJoined')
  ts.close()
})

// ── close() gating ────────────────────────────────────────────────────────────

test('after close(), every call fails with typed closed; close() is idempotent', async () => {
  const ts = await open()
  ts.onMessage(() => {})
  ts.close()
  ts.close() // idempotent

  const closedCalls = [
    () => ts.status,
    () => ts.me,
    () => ts.members,
    () => ts.connection,
    () => ts.send(Buffer.alloc(1)),
    () => ts.startPairing(),
    () => ts.accept('x'),
    () => ts.cancelPairing(),
    () => ts.join('x'),
    () => ts.cancelJoin(),
    () => ts.remove('x'),
    () => ts.leave(),
    () => ts.destroyGroup(),
    () => ts.onMessage(() => {}),
  ]
  for (const call of closedCalls) {
    try {
      call()
      ok(false, 'expected typed closed')
    } catch (err) {
      ok(err instanceof TrueSealError, `typed error, got ${err}`)
      strictEqual(err.code, 'closed')
    }
  }
})

// ── send() typed failures, relay-free ─────────────────────────────────────────

test('send on a non-member: notMember carrying the status extra', async () => {
  const ts = await open()
  try {
    ts.send(Buffer.from('hello'))
    ok(false, 'send must fail when not a member')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'notMember')
    strictEqual(err.status, 'notJoined')
  }
  ts.close()
})

test('send over the Protocol Size Limit: payloadTooLarge carrying max', async () => {
  const ts = await open()
  try {
    ts.send(Buffer.alloc(61441))
    ok(false, 'oversize send must fail')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'payloadTooLarge')
    strictEqual(err.max, 61440)
  }
  // The boundary itself: exactly max bytes is NOT too large (fails on
  // membership instead — the size check passed).
  try {
    ts.send(Buffer.alloc(61440))
    ok(false, 'still not a member')
  } catch (err) {
    strictEqual(err.code, 'notMember')
  }
  ts.close()
})

// ── The relay-free slice of the pairing state machine ─────────────────────────

test('join moves to pendingJoin; cancelJoin returns to notJoined', async () => {
  const admitter = await open('admitter')
  const joiner = await open('joiner')

  const token = admitter.startPairing()
  strictEqual(typeof token, 'string')
  ok(token.length > 0)

  joiner.join(token)
  strictEqual(joiner.status, 'pendingJoin') // synchronous transition: learn it from the call

  joiner.cancelJoin()
  strictEqual(joiner.status, 'notJoined')

  admitter.cancelPairing()
  admitter.close()
  joiner.close()
})

test('accept with an unknown request id: pairingClosed', async () => {
  const ts = await open()
  ts.startPairing()
  try {
    ts.accept('no-such-request')
    ok(false, 'unknown request id must fail')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'pairingClosed')
  }
  ts.cancelPairing()
  ts.close()
})

test('join with a malformed token: invalidPairingToken', async () => {
  const ts = await open()
  try {
    ts.join('not-a-token')
    ok(false, 'malformed token must fail')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'invalidPairingToken')
  }
  ts.close()
})

// ── open() typed failures ─────────────────────────────────────────────────────

test('open with a bad Relay Address: invalidRelayAddress', async () => {
  await TrueSeal.open('nope', { storageDir: TMP() }).then(
    () => ok(false, 'must reject'),
    (err) => {
      ok(err instanceof TrueSealError)
      strictEqual(err.code, 'invalidRelayAddress')
    },
  )
})

test('open with an illegal namespace: invalidNamespace', async () => {
  await TrueSeal.open(ADDRESS, { storageDir: TMP(), namespace: 'bad namespace!' }).then(
    () => ok(false, 'must reject'),
    (err) => {
      ok(err instanceof TrueSealError)
      strictEqual(err.code, 'invalidNamespace')
    },
  )
})

test('open accepts the typed RelayAddress form', async () => {
  const ts = await TrueSeal.open(new RelayAddress('127.0.0.1', KEY), { storageDir: TMP() })
  strictEqual(ts.status, 'notJoined')
  ts.close()
})
