// Smoke tests — two HushSyncClient instances against a real local relay.
//
// Requires: hush-relay running on localhost:7700/7701.
//
// Run the relay:
//   cd ../hush-relay && ./hush-relay -config relay.toml
//
// The relay public key is printed at startup, e.g.:
//   relay public key: 3f783127c25c91ac8ea02ab97edca78e5708e0c686fa0cc2e714c135c7cd095e
//
// Set RELAY_PUB_KEY env var to the relay's 64-char hex public key, or edit
// RELAY_PUB_HEX below to match your local relay keypair.
//
// Tests are skipped automatically when the relay is unreachable.
//
// Skip all:      SKIP_RELAY_TESTS=1 npm test
// Run only these: node --test --test-force-exit '__tests__/smoke.test.mjs'

import { ok, strictEqual, deepStrictEqual } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { createConnection } from 'node:net'

import { HushSyncClient, HushSyncError } from '../dist/index.js'

// ── Config ────────────────────────────────────────────────────────────────────

const RELAY_HOST   = process.env.RELAY_HOST    ?? 'localhost'
const RELAY_PUB_HEX = process.env.RELAY_PUB_KEY ?? '3f783127c25c91ac8ea02ab97edca78e5708e0c686fa0cc2e714c135c7cd095e'
const RELAY_PUB    = Buffer.from(RELAY_PUB_HEX, 'hex')
const RELAY_PORT   = 7700
const TIMEOUT_MS   = 8000

const TMP = () => mkdtempSync(join(tmpdir(), 'hush-smoke-'))

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
  return HushSyncClient.create({
    relayHost: RELAY_HOST,
    relayPublicKey: RELAY_PUB,
    storageDir: dir,
    namespace: 'smoke',
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const relayUp = await isRelayReachable()

if (!relayUp) {
  console.log('# SKIP: relay unreachable. Start hush-relay to run smoke tests.')
  console.log(`# Expected: ${RELAY_HOST}:${RELAY_PORT}  pub=${RELAY_PUB_HEX}`)
  console.log('# Override pub key: RELAY_PUB_KEY=<hex> npm test')
  console.log('# Skip all: SKIP_RELAY_TESTS=1 npm test')
} else {
  test('smoke: two sessions connect to relay', { timeout: TIMEOUT_MS }, async () => {
    const a = await makeClient()
    const b = await makeClient()

    const connA = waitForEvent(a, 'connectionChanged')
    const connB = waitForEvent(b, 'connectionChanged')

    const [connectedA] = await connA
    const [connectedB] = await connB

    ok(connectedA, 'session A connected to relay')
    ok(connectedB, 'session B connected to relay')
  })

  test('smoke: pair → memberJoined on both sides', { timeout: TIMEOUT_MS }, async () => {
    const dirA = TMP()
    const dirB = TMP()
    const a = await makeClient(dirA)
    const b = await makeClient(dirB)

    // Wait for both to connect
    await waitForEvent(a, 'connectionChanged')
    await waitForEvent(b, 'connectionChanged')

    // A opens pairing window
    const token = a.pairingToken()
    ok(token.length > 0, 'got pairing token')

    // A listens for pairing request
    const memberRequestPromise = new Promise((resolve) => {
      a.onMemberRequest((requestToken, name) => {
        resolve({ requestToken, name })
      })
    })

    // B scans the token
    b.joinGroup(token)

    // A receives the request and accepts
    const joinedAPromise = waitForEvent(a, 'memberJoined')
    const joinedBPromise = waitForEvent(b, 'memberJoined')

    const { requestToken, name } = await memberRequestPromise
    ok(requestToken.length > 0, 'request token present')
    ok(name.length > 0, 'device name present')

    const accepted = a.acceptPairingRequest(requestToken)
    ok(accepted, 'member accepted')

    // Both sides fire memberJoined
    const [memberOnA] = await joinedAPromise
    const [memberOnB] = await joinedBPromise

    strictEqual(memberOnA.id, b.localNodeId, 'A sees B as new member')
    strictEqual(memberOnB.id, a.localNodeId, 'B sees A as new member')
  })

  test('smoke: send blob A→B', { timeout: TIMEOUT_MS }, async () => {
    const dirA = TMP()
    const dirB = TMP()
    const a = await makeClient(dirA)
    const b = await makeClient(dirB)

    await waitForEvent(a, 'connectionChanged')
    await waitForEvent(b, 'connectionChanged')

    // Pair
    const token = a.pairingToken()
    const requestPromise = new Promise(resolve => {
      a.onMemberRequest((requestToken) => resolve(requestToken))
    })
    b.joinGroup(token)
    await waitForEvent(a, 'memberJoined')
    const requestToken = await requestPromise
    a.acceptPairingRequest(requestToken)
    await waitForEvent(b, 'memberJoined')

    // Send blob from A, receive on B
    const msgPromise = waitForEvent(b, 'message')
    const payload = Buffer.from('hello from A')
    await a.send(payload)

    const [receivedBlob, senderId] = await msgPromise
    deepStrictEqual(Buffer.from(receivedBlob), payload, 'blob bytes match')
    strictEqual(typeof senderId, 'string', 'senderId is a string')
  })

  test('smoke: members() lists remote peer after pairing', { timeout: TIMEOUT_MS }, async () => {
    const a = await makeClient()
    const b = await makeClient()

    await waitForEvent(a, 'connectionChanged')
    await waitForEvent(b, 'connectionChanged')

    // Pair
    const token = a.pairingToken()
    const requestPromise = new Promise(resolve => {
      a.onMemberRequest(requestToken => resolve(requestToken))
    })
    b.joinGroup(token)
    const requestToken = await requestPromise
    a.acceptPairingRequest(requestToken)
    await waitForEvent(a, 'memberJoined')
    await waitForEvent(b, 'memberJoined')

    const membersA = a.members
    const membersB = b.members

    strictEqual(membersA.length, 1, 'A has 1 member')
    strictEqual(membersB.length, 1, 'B has 1 member')
    strictEqual(membersA[0].id, b.localNodeId, 'A sees B')
    strictEqual(membersB[0].id, a.localNodeId, 'B sees A')
    ok(membersA[0].name.length > 0, 'member name non-empty')
  })

  test('smoke: removeMember fires removedFromGroup on removed device', { timeout: TIMEOUT_MS }, async () => {
    const a = await makeClient()
    const b = await makeClient()

    await waitForEvent(a, 'connectionChanged')
    await waitForEvent(b, 'connectionChanged')

    // Pair
    const token = a.pairingToken()
    const requestPromise = new Promise(resolve => {
      a.onMemberRequest(requestToken => resolve(requestToken))
    })
    b.joinGroup(token)
    const requestToken = await requestPromise
    a.acceptPairingRequest(requestToken)
    await waitForEvent(a, 'memberJoined')
    await waitForEvent(b, 'memberJoined')

    // A removes B
    const removedPromise = waitForEvent(b, 'removedFromGroup')
    a.removeMember(b.localNodeId)

    await removedPromise  // B fires removedFromGroup
  })

  test('smoke: destroyGroup fires groupDestroyed on all members', { timeout: TIMEOUT_MS }, async () => {
    const a = await makeClient()
    const b = await makeClient()

    await waitForEvent(a, 'connectionChanged')
    await waitForEvent(b, 'connectionChanged')

    // Pair
    const token = a.pairingToken()
    const requestPromise = new Promise(resolve => {
      a.onMemberRequest(requestToken => resolve(requestToken))
    })
    b.joinGroup(token)
    const requestToken = await requestPromise
    a.acceptPairingRequest(requestToken)
    await waitForEvent(a, 'memberJoined')
    await waitForEvent(b, 'memberJoined')

    // A destroys group
    const destroyedA = waitForEvent(a, 'groupDestroyed')
    const destroyedB = waitForEvent(b, 'groupDestroyed')
    a.destroyGroup()

    await Promise.all([destroyedA, destroyedB])
  })
}
