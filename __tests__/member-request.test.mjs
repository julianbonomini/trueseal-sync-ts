// Tests for P6: onMemberRequest refactor.
//
// Previously onMemberRequest(fn) called _session.setOnMemberRequest(fn)
// directly — a raw callback setter. Issues:
//   - Overwrites on re-call (only one listener at a time)
//   - Cannot be removed with off()
//   - Inconsistent with all other events
//
// Fix: wire 'memberRequest' through EventEmitter so it behaves like
// every other event. onMemberRequest(fn) becomes a convenience alias
// for on('memberRequest', fn).

import { ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

import indexPkg from '../dist/index.js'
const { TruesealSyncClient } = indexPkg

const RELAY_PUB = Buffer.alloc(32, 0x01)
const TMP = () => mkdtempSync(join(tmpdir(), 'trueseal-p6-test-'))

async function makeClient() {
  return TruesealSyncClient.create({
    relayHost: '127.0.0.1',
    relayPublicKey: RELAY_PUB,
    storageDir: TMP(),
    namespace: 'p6',
  })
}

// ── Multiple listeners ────────────────────────────────────────────────────────

test('multiple onMemberRequest listeners can be registered independently', async () => {
  const client = await makeClient()
  const h1 = () => {}
  const h2 = () => {}
  client.on('memberRequest', h1)
  client.on('memberRequest', h2)
  strictEqual(client.listenerCount('memberRequest'), 2, 'two listeners registered')
})

// ── off() removes the listener ────────────────────────────────────────────────

test('off() removes a memberRequest listener', async () => {
  const client = await makeClient()
  const handler = () => {}
  client.on('memberRequest', handler)
  strictEqual(client.listenerCount('memberRequest'), 1)
  client.off('memberRequest', handler)
  strictEqual(client.listenerCount('memberRequest'), 0)
})

// ── onMemberRequest() is a convenience alias for on('memberRequest') ──────────

test('onMemberRequest(fn) is equivalent to on("memberRequest", fn)', async () => {
  const client = await makeClient()
  const fn = () => {}
  client.onMemberRequest(fn)
  // The listener added by onMemberRequest must be removable via off('memberRequest').
  ok(client.listenerCount('memberRequest') > 0, 'listener was registered')
  client.off('memberRequest', fn)
  strictEqual(client.listenerCount('memberRequest'), 0, 'listener was removed by off()')
})

test('onMemberRequest called twice registers two independent listeners', async () => {
  const client = await makeClient()
  const h1 = () => {}
  const h2 = () => {}
  client.onMemberRequest(h1)
  client.onMemberRequest(h2)
  strictEqual(client.listenerCount('memberRequest'), 2)
})

// ── dispose() clears memberRequest listeners ──────────────────────────────────

test('dispose() removes memberRequest listeners', async () => {
  const client = await makeClient()
  client.on('memberRequest', () => {})
  client.dispose()
  strictEqual(client.listenerCount('memberRequest'), 0)
})
