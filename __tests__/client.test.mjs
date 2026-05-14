// RED: HushSyncClient TypeScript wrapper.
// Tests verify the clean public API surface — no raw NAPI types exposed.
import { strictEqual, ok, throws, rejects, deepStrictEqual } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

// Will throw if src/index.ts hasn't been compiled yet → RED
import { HushSyncClient, HushSyncError } from '../dist/index.js'

const RELAY_PUB = Buffer.alloc(32, 0x01)
const TMP = () => mkdtempSync(join(tmpdir(), 'hush-ts-test-'))

function makeClient(dir = TMP()) {
  return HushSyncClient.create({
    relayHost: '127.0.0.1',
    relayPublicKey: RELAY_PUB,
    storageDir: dir,
    namespace: 'default',
  })
}

// ── Construction ──────────────────────────────────────────────────────────────

test('HushSyncClient.create() returns a client instance', async () => {
  const client = await makeClient()
  ok(client instanceof HushSyncClient, 'is HushSyncClient')
})

test('HushSyncClient.create() throws HushSyncError on bad relay key', async () => {
  await rejects(
    () => HushSyncClient.create({
      relayHost: '127.0.0.1',
      relayPublicKey: Buffer.alloc(4),   // wrong length
      storageDir: TMP(),
      namespace: 'default',
    }),
    (err) => {
      ok(err instanceof HushSyncError, 'is HushSyncError')
      return true
    }
  )
})

// ── Identity ──────────────────────────────────────────────────────────────────

test('localNodeId is a non-empty string', async () => {
  const client = await makeClient()
  ok(typeof client.localNodeId === 'string' && client.localNodeId.length > 0)
})

test('localDeviceName is a non-empty string', async () => {
  const client = await makeClient()
  ok(typeof client.localDeviceName === 'string' && client.localDeviceName.length > 0)
})

// ── Members ───────────────────────────────────────────────────────────────────

test('members returns empty array before pairing', async () => {
  const client = await makeClient()
  deepStrictEqual(client.members, [])
})

// ── Pairing token ─────────────────────────────────────────────────────────────

test('pairingToken() returns a non-empty string', async () => {
  const client = await makeClient()
  const token = client.pairingToken()
  ok(typeof token === 'string' && token.length > 0)
})

// ── EventEmitter interface ────────────────────────────────────────────────────

test('on() accepts all typed event names', async () => {
  const client = await makeClient()
  // Just verify the typed on() doesn't throw for any valid event name
  client.on('message',           () => {})
  client.on('memberJoined',      () => {})
  client.on('memberLeft',        () => {})
  client.on('removedFromGroup',  () => {})
  client.on('groupDestroyed',    () => {})
  client.on('connectionChanged', () => {})
})

// ── send() before pairing ─────────────────────────────────────────────────────

test('send() before pairing rejects with HushSyncError.notInGroup', async () => {
  const client = await makeClient()
  await rejects(
    () => client.send(Buffer.from('hello')),
    (err) => {
      ok(err instanceof HushSyncError, `expected HushSyncError, got ${err}`)
      return true
    }
  )
})

// ── HushSyncError ─────────────────────────────────────────────────────────────

test('HushSyncError is an Error subclass', () => {
  const e = new HushSyncError('test message')
  ok(e instanceof Error)
  ok(e instanceof HushSyncError)
  strictEqual(e.message, 'test message')
})
