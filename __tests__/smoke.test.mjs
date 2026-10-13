// Smoke tests — two TrueSeal instances against a real local relay, through
// the canonical public API (SDK-1).
//
// Requires: trueseal-relay running on localhost:7700/7701.
//
// Run the relay:
//   cd ../trueseal-relay && ./trueseal-relay
//
// Set RELAY_PUB_KEY env var to override the relay's 64-char hex public key.
//
// Tests are skipped automatically when the relay is unreachable.
//
// Skip all:  SKIP_RELAY_TESTS=1 npm test
// Run only:  node --test --test-force-exit '__tests__/smoke.test.mjs'

import { ok, strictEqual, deepStrictEqual } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { createConnection } from 'node:net'

import { TrueSeal } from '../dist/index.js'

// ── Config ────────────────────────────────────────────────────────────────────

const RELAY_HOST    = process.env.RELAY_HOST    ?? 'localhost'
const RELAY_PUB_HEX = process.env.RELAY_PUB_KEY ?? '3f783127c25c91ac8ea02ab97edca78e5708e0c686fa0cc2e714c135c7cd095e'
const RELAY_PORT    = 7700
const ADDRESS       = `trueseal://${RELAY_PUB_HEX}@${RELAY_HOST}`
const TIMEOUT_MS    = 15000

const TMP = () => mkdtempSync(join(tmpdir(), 'trueseal-smoke-'))

// ── Relay availability check ──────────────────────────────────────────────────

async function isRelayReachable() {
  if (process.env.SKIP_RELAY_TESTS === '1') return false
  return new Promise(resolve => {
    const sock = createConnection({ host: RELAY_HOST, port: RELAY_PORT })
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error',   () => resolve(false))
    setTimeout(() => { sock.destroy(); resolve(false) }, 1000)
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function waitForEvent(ts, type, timeoutMs = TIMEOUT_MS, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => { sub.cancel(); reject(new Error(`Timed out waiting for '${type}' after ${timeoutMs}ms`)) },
      timeoutMs,
    )
    const sub = ts.onEvent((event) => {
      if (event.type === type && predicate(event)) {
        clearTimeout(timer)
        sub.cancel()
        resolve(event)
      }
    })
  })
}

function waitForConnection(ts, state, timeoutMs = TIMEOUT_MS) {
  if (ts.connection.state === state) return Promise.resolve()
  return waitForEvent(ts, 'connectionChanged', timeoutMs, (e) => e.connection.state === state)
}

async function makeClient(dir = TMP()) {
  return TrueSeal.open(ADDRESS, { storageDir: dir, namespace: 'smoke' })
}

// Two connected clients. The connection waits are registered BEFORE either
// can complete — both sessions can connect before the second await is reached.
async function makePair() {
  const a = await makeClient()
  const connA = waitForConnection(a, 'connected')
  const b = await makeClient()
  const connB = waitForConnection(b, 'connected')
  await connA
  await connB
  return [a, b]
}

// Full canonical pairing flow: A opens the window → B joins → A sees the
// joinRequest EVENT → A accepts → both reach `member` via statusChanged.
async function pair(a, b) {
  const token = a.startPairing()

  const requestSeen = waitForEvent(a, 'joinRequest')
  const joinedA = waitForEvent(a, 'statusChanged', TIMEOUT_MS, (e) => e.status === 'member')
  const joinedB = waitForEvent(b, 'statusChanged', TIMEOUT_MS, (e) => e.status === 'member')

  b.join(token)
  strictEqual(b.status, 'pendingJoin', 'join moves to pendingJoin synchronously')

  const request = await requestSeen
  ok(request.request.id.length > 0, 'joinRequest carries the opaque id')
  ok(request.request.name.length > 0, 'joinRequest carries the joiner name')

  a.accept(request.request.id)

  await joinedA
  await joinedB
  strictEqual(a.status, 'member')
  strictEqual(b.status, 'member')
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const relayUp = await isRelayReachable()

// Register the tests even when the relay is down, with node:test's skip
// option, so the suite REPORTS the skips instead of silently passing with
// fewer tests than expected.
const smokeOpts = relayUp
  ? { timeout: TIMEOUT_MS * 2 }
  : { timeout: TIMEOUT_MS, skip: `relay unreachable at ${RELAY_HOST}:${RELAY_PORT} — start trueseal-relay to run smoke tests (see file header)` }

if (!relayUp) {
  console.log('# SKIP: relay unreachable. Start trueseal-relay to run smoke tests.')
  console.log(`# Expected: ${RELAY_HOST}:${RELAY_PORT}  pub=${RELAY_PUB_HEX}`)
  console.log('# Override: RELAY_PUB_KEY=<hex> npm test')
  console.log('# Force skip: SKIP_RELAY_TESTS=1 npm test')
}

{
  test('smoke: two clients connect — connectionChanged carries the canonical state', smokeOpts, async () => {
    const [a, b] = await makePair()
    strictEqual(a.connection.state, 'connected')
    strictEqual(b.connection.state, 'connected')
    a.close()
    b.close()
  })

  test('smoke: pair via token — joinRequest event, accept, statusChanged(member)', smokeOpts, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    ok(a.members.find(m => m.id === b.me.id), 'A sees B')
    ok(b.members.find(m => m.id === a.me.id), 'B sees A')
    a.close()
    b.close()
  })

  test('smoke: send returns the MessageId; the awaited async handler receives the Message', smokeOpts, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for the message')), TIMEOUT_MS)
      // The handler is ASYNC — the core awaits it before acking (ADR-0026).
      b.onMessage(async (message) => {
        await new Promise((r) => setTimeout(r, 50))
        clearTimeout(timer)
        resolve(message)
      })
    })

    const payload = Buffer.from('hello from A')
    const messageId = a.send(payload)
    strictEqual(typeof messageId, 'string', 'send returns the MessageId')
    ok(messageId.startsWith('tsm1_'), 'the MessageId is versioned and opaque')

    const message = await received
    deepStrictEqual(Buffer.from(message.body), payload, 'body bytes match')
    strictEqual(message.id, messageId, 'the delivered id is the id send() returned')
    strictEqual(message.from.id, a.me.id, 'from.id is the sender member id')
    ok(message.from.name.length > 0, 'from.name is populated')
    a.close()
    b.close()
  })

  test('smoke: members lists the remote peer after pairing', smokeOpts, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    strictEqual(a.members.length, 1, 'A has 1 member')
    strictEqual(b.members.length, 1, 'B has 1 member')
    strictEqual(a.members[0].id, b.me.id, 'A sees B')
    strictEqual(b.members[0].id, a.me.id, 'B sees A')
    ok(a.members[0].name.length > 0, 'member name non-empty')
    a.close()
    b.close()
  })

  test('smoke: remove fires statusChanged(notJoined, removed) on the removed device', smokeOpts, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    const removed = waitForEvent(b, 'statusChanged', TIMEOUT_MS, (e) => e.status === 'notJoined')
    a.remove(b.me.id)
    const event = await removed
    strictEqual(event.reason, 'removed')
    strictEqual(b.status, 'notJoined')
    a.close()
    b.close()
  })

  test('smoke: Destroy Group — both reach notJoined(destroyed) and can pair again (the lifecycle rule)', smokeOpts, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    const destroyedA = waitForEvent(a, 'statusChanged', TIMEOUT_MS, (e) => e.status === 'notJoined')
    const destroyedB = waitForEvent(b, 'statusChanged', TIMEOUT_MS, (e) => e.status === 'notJoined')
    a.destroyGroup()
    strictEqual(a.status, 'destroying', 'destroyGroup moves to destroying synchronously')

    const [eventA, eventB] = await Promise.all([destroyedA, destroyedB])
    strictEqual(eventA.reason, 'destroyed')
    strictEqual(eventB.reason, 'destroyed')

    // The ADR-0028 lifecycle rule: the SAME objects pair again.
    await pair(a, b)
    ok(a.members.find(m => m.id === b.me.id), 'A sees B after re-pairing')
    ok(b.members.find(m => m.id === a.me.id), 'B sees A after re-pairing')
    a.close()
    b.close()
  })

  test('smoke: leave moves through leaving to notJoined(left)', smokeOpts, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    const left = waitForEvent(b, 'statusChanged', TIMEOUT_MS, (e) => e.status === 'notJoined')
    b.leave()
    strictEqual(b.status, 'leaving', 'leave moves to leaving synchronously')
    const event = await left
    strictEqual(event.reason, 'left')
    a.close()
    b.close()
  })

  // Regression test for the thenable-probe fix (SDK-1 review P2.1): a
  // handler returning an object with a THROWING `then` getter must not
  // escape the dispatcher synchronously (a throw into the TSFN callback is
  // ErrorStrategy::Fatal → SIGABRT). It is a failed attempt: the core
  // retries and reports handlerGaveUp — and the process lives.
  test('smoke: a handler returning a thenable with a throwing `then` getter — failed attempts, never a crash', smokeOpts, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    const gaveUp = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no handlerGaveUp reported')), TIMEOUT_MS * 2)
      b.onDeliveryIssue((issue) => {
        if (issue.type === 'handlerGaveUp') {
          clearTimeout(timer)
          resolve(issue)
        }
      })
    })
    b.onMessage(() => ({
      get then() {
        throw new Error('evil getter')
      },
    }))

    const messageId = a.send(Buffer.from('evil thenable'))
    const issue = await gaveUp
    strictEqual(issue.messageId, messageId)
    ok(issue.error.includes('evil getter'), `the getter's error is reported, got: ${issue.error}`)
    // The process survived and the SDK is still usable.
    strictEqual(b.status, 'member')
    a.close()
    b.close()
  })

  // Regression test for the close()-drain fix (SDK-1 review P1): close()
  // must resolve parked JS-handler completions with Ok(()), reaching the
  // core's graceful-shutdown path (session/mod.rs, SYNC-15 F2) — NOT with
  // an error, which would count FAILED attempts: backoff, re-invocation of
  // the user's handler after close(), and a spurious handlerGaveUp.
  // Relay-backed by necessity: an in-flight delivery is the only way to
  // have a parked handler. The decisive invariant is RE-DELIVERY: with the
  // buggy drain the blob is acked+dropped after 5 attempts and never
  // re-appears; with the graceful path it is abandoned unrecorded and the
  // relay re-delivers on the next open.
  test('smoke: close() with an in-flight handler — no re-invocation, no handlerGaveUp, re-delivered on next open', smokeOpts, async () => {
    const dirA = TMP()
    const dirB = TMP()
    const a = await makeClient(dirA)
    const connA = waitForConnection(a, 'connected')
    const b = await makeClient(dirB)
    const connB = waitForConnection(b, 'connected')
    await connA
    await connB
    await pair(a, b)

    const issues = []
    b.onDeliveryIssue((issue) => issues.push(issue))

    let releaseHandler
    const blocker = new Promise((resolve) => { releaseHandler = resolve })
    let invocations = 0
    const entered = new Promise((resolve) => {
      b.onMessage(async () => {
        invocations += 1
        resolve()         // signal: the handler is parked on the first delivery
        await blocker     // stay parked until the test releases it (after close)
      })
    })

    const payload = Buffer.from('close mid-handler')
    const messageId = a.send(payload)
    await entered // the handler is in-flight

    b.close()      // close WHILE the handler is parked
    releaseHandler() // the parked handler settles AFTER close

    // The buggy drain counted failed attempts; backoff re-invocations start
    // at 250ms. Two seconds covers several — none may happen.
    await new Promise((r) => setTimeout(r, 2000))
    strictEqual(invocations, 1, 'the handler is never re-invoked after close()')
    ok(!issues.some((i) => i.type === 'handlerGaveUp'), 'no spurious handlerGaveUp post-close')

    // The delivery was abandoned UNRECORDED: the next open re-delivers it
    // (the same store = the same identity, still a member).
    const b2 = await TrueSeal.open(ADDRESS, { storageDir: dirB, namespace: 'smoke' })
    const redelivered = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no re-delivery after reopen')), TIMEOUT_MS)
      b2.onMessage((message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
    await waitForConnection(b2, 'connected')
    const message = await redelivered
    strictEqual(message.id, messageId, 'the unacked message is re-delivered with the same MessageId')
    deepStrictEqual(Buffer.from(message.body), payload)

    a.close()
    b2.close()
  })
}
