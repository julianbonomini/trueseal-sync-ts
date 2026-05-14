// RED: session NAPI bindings — all tests fail until Rust glue is implemented.
import { strictEqual, ok, throws, rejects } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('../index.js')

const RELAY_PUB_32 = Buffer.alloc(32, 0x01) // dummy 32-byte key
const TMP = () => mkdtempSync(join(tmpdir(), 'trueseal-test-'))

// ── Existence ─────────────────────────────────────────────────────────────────

test('HushSession class is exported', () => {
  ok(native.HushSession, 'HushSession must be exported')
  strictEqual(typeof native.HushSession, 'function', 'HushSession is a constructor')
})

// ── Constructor validation ────────────────────────────────────────────────────

test('create() throws on short relay pub key', () => {
  throws(() => {
    new native.HushSession(
      TMP(), 'default', 'relay.example.com',
      Buffer.alloc(16),   // wrong length
      () => {},           // onMessage
      () => {},           // onRemovedFromGroup
      () => {},           // onGroupDestroyed
      null                // onConnectionChanged (optional)
    )
  }, /invalid/i)
})

test('create() succeeds with valid params (relay unreachable is ok)', () => {
  // relay connects in background — constructor must not throw even if relay is down
  const session = new native.HushSession(
    TMP(), 'default', '127.0.0.1',
    RELAY_PUB_32,
    () => {},
    () => {},
    () => {},
    null
  )
  ok(session, 'session object returned')
})

// ── Identity ──────────────────────────────────────────────────────────────────

test('localNodeId() returns a non-empty string', () => {
  const session = new native.HushSession(
    TMP(), 'default', '127.0.0.1', RELAY_PUB_32,
    () => {}, () => {}, () => {}, null
  )
  const id = session.localNodeId()
  ok(typeof id === 'string' && id.length > 0, `expected non-empty string, got ${id}`)
})

test('localDeviceName() returns a non-empty string', () => {
  const session = new native.HushSession(
    TMP(), 'default', '127.0.0.1', RELAY_PUB_32,
    () => {}, () => {}, () => {}, null
  )
  const name = session.localDeviceName()
  ok(typeof name === 'string' && name.length > 0, `expected non-empty string, got ${name}`)
})

// ── Group state ───────────────────────────────────────────────────────────────

test('members() returns empty array before pairing', () => {
  const session = new native.HushSession(
    TMP(), 'default', '127.0.0.1', RELAY_PUB_32,
    () => {}, () => {}, () => {}, null
  )
  const members = session.members()
  ok(Array.isArray(members), 'members() returns array')
  strictEqual(members.length, 0, 'no members before pairing')
})

test('pairingToken() returns a non-empty string', () => {
  const session = new native.HushSession(
    TMP(), 'default', '127.0.0.1', RELAY_PUB_32,
    () => {}, () => {}, () => {}, null
  )
  const token = session.pairingToken()
  ok(typeof token === 'string' && token.length > 0, `expected token string, got ${token}`)
})

// ── Member record shape ───────────────────────────────────────────────────────

test('Member record has id and name fields', () => {
  // We can't easily get a real Member without pairing,
  // so we verify the shape via localNodeId/localDeviceName symmetry instead.
  // The full Member shape test lives in smoke tests (#5).
  const session = new native.HushSession(
    TMP(), 'default', '127.0.0.1', RELAY_PUB_32,
    () => {}, () => {}, () => {}, null
  )
  // pairingToken encodes our own keys — pairing against self is degenerate,
  // so just assert the two identity fields are consistent non-empty strings.
  const id   = session.localNodeId()
  const name = session.localDeviceName()
  ok(id.length > 0)
  ok(name.length > 0)
})
