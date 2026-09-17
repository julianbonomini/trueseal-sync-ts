// Smoke tests — two TruesealSyncClient instances against a real local relay.
//
// Requires: trueseal-relay running on localhost:7700/7701.
//
// Run the relay:
//   cd ../trueseal-relay && ./trueseal-relay -config relay.toml
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

import { TruesealSyncClient } from '../dist/index.js'

// ── Config ────────────────────────────────────────────────────────────────────

const RELAY_HOST    = process.env.RELAY_HOST    ?? 'localhost'
const RELAY_PUB_HEX = process.env.RELAY_PUB_KEY ?? '3f783127c25c91ac8ea02ab97edca78e5708e0c686fa0cc2e714c135c7cd095e'
const RELAY_PUB     = Buffer.from(RELAY_PUB_HEX, 'hex')
const RELAY_PORT    = 7700
const TIMEOUT_MS    = 10000

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

function waitForEvent(emitter, event, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for '${event}' after ${timeoutMs}ms`)),
      timeoutMs,
    )
    emitter.once(event, (...args) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

async function makeClient(dir = TMP()) {
  return TruesealSyncClient.create({
    relayHost: RELAY_HOST,
    relayPublicKey: RELAY_PUB,
    storageDir: dir,
    namespace: 'smoke',
  })
}

// Register waitFor listeners for connectionChanged on BOTH clients before
// awaiting either — both sessions can connect before the second await is reached.
async function makePair() {
  const a = await makeClient()
  const connA = waitForEvent(a, 'connectionChanged')
  const b = await makeClient()
  const connB = waitForEvent(b, 'connectionChanged')
  await connA
  await connB
  return [a, b]
}

// Full pairing flow: A opens window → B joins → A accepts → both fire memberJoined.
// Listeners for memberJoined are set up BEFORE acceptPairingRequest to avoid
// missing the event (it fires asynchronously but very quickly).
async function pair(a, b) {
  const token = a.pairingToken()

  // Set up all event listeners BEFORE triggering any side effects.
  const joinedA   = waitForEvent(a, 'memberJoined')
  const joinedB   = waitForEvent(b, 'memberJoined')
  const reqPromise = new Promise(resolve => {
    a.onMemberRequest((requestToken, name) => resolve({ requestToken, name }))
  })

  b.joinGroup(token)

  const { requestToken } = await reqPromise
  a.acceptPairingRequest(requestToken)

  await joinedA
  await joinedB
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const relayUp = await isRelayReachable()

if (!relayUp) {
  console.log('# SKIP: relay unreachable. Start trueseal-relay to run smoke tests.')
  console.log(`# Expected: ${RELAY_HOST}:${RELAY_PORT}  pub=${RELAY_PUB_HEX}`)
  console.log('# Override: RELAY_PUB_KEY=<hex> npm test')
  console.log('# Force skip: SKIP_RELAY_TESTS=1 npm test')
} else {
  test('smoke: two sessions connect to relay', { timeout: TIMEOUT_MS }, async () => {
    const [a, b] = await makePair()
    ok(a, 'session A created')
    ok(b, 'session B created')
  })

  test('smoke: pair → memberJoined on both sides', { timeout: TIMEOUT_MS }, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    ok(a.members.find(m => m.id === b.localNodeId), 'A sees B')
    ok(b.members.find(m => m.id === a.localNodeId), 'B sees A')
  })

  test('smoke: send blob A→B', { timeout: TIMEOUT_MS }, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    const msgPromise = waitForEvent(b, 'message')
    const payload    = Buffer.from('hello from A')
    await a.send(payload)

    const [receivedBlob, senderId, messageId] = await msgPromise
    deepStrictEqual(Buffer.from(receivedBlob), payload, 'blob bytes match')
    strictEqual(typeof senderId, 'string', 'senderId is a string')
    strictEqual(typeof messageId, 'string', 'messageId is a string')
    ok(messageId.startsWith('tsm1_'), 'messageId is a versioned opaque ID')
  })

  test('smoke: members() lists remote peer after pairing', { timeout: TIMEOUT_MS }, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    strictEqual(a.members.length, 1, 'A has 1 member')
    strictEqual(b.members.length, 1, 'B has 1 member')
    strictEqual(a.members[0].id, b.localNodeId, 'A sees B')
    strictEqual(b.members[0].id, a.localNodeId, 'B sees A')
    ok(a.members[0].name.length > 0, 'member name non-empty')
  })

  test('smoke: removeMember fires removedFromGroup on removed device', { timeout: TIMEOUT_MS }, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    const removedPromise = waitForEvent(b, 'removedFromGroup')
    a.removeMember(b.localNodeId)
    await removedPromise
  })

  test('smoke: destroyGroup fires groupDestroyed on all members', { timeout: TIMEOUT_MS }, async () => {
    const [a, b] = await makePair()
    await pair(a, b)

    const destroyedA = waitForEvent(a, 'groupDestroyed')
    const destroyedB = waitForEvent(b, 'groupDestroyed')
    a.destroyGroup()
    await Promise.all([destroyedA, destroyedB])
  })
}
