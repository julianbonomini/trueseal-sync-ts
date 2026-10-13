// Session NAPI bindings — the internal CoreSession class (never in public types).
import { strictEqual, ok, throws } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const native = require('../index.js')

const KEY_HEX = Buffer.alloc(32, 0x01).toString('hex')
const ADDRESS = `trueseal://${KEY_HEX}@127.0.0.1`
const TMP = () => mkdtempSync(join(tmpdir(), 'trueseal-native-'))

const newSession = (dir, namespace = 'default') =>
  new native.CoreSession(ADDRESS, dir, namespace, null, () => {}, () => {})

// ── Existence ─────────────────────────────────────────────────────────────────

test('CoreSession class is exported', () => {
  ok(native.CoreSession, 'CoreSession must be exported')
  strictEqual(typeof native.CoreSession, 'function', 'CoreSession is a constructor')
})

test('module-level functions are exported', () => {
  for (const fn of ['parseRelayAddress', 'truesealInfo', 'truesealMaxPayloadBytes', 'truesealMaxGroupSize']) {
    strictEqual(typeof native[fn], 'function', `${fn} exported`)
  }
})

// ── Constructor validation ────────────────────────────────────────────────────

test('constructor throws typed invalidRelayAddress on a bad address', () => {
  try {
    new native.CoreSession('not an address', TMP(), 'default', null, () => {}, () => {})
    ok(false, 'must throw')
  } catch (err) {
    strictEqual(err.code, 'invalidRelayAddress')
  }
})

test('constructor succeeds with a valid address (relay unreachable is ok)', () => {
  // The relay connects in the background — the constructor must not throw
  // even if the relay is down.
  const session = newSession(TMP())
  ok(session, 'session object returned')
  session.close()
})

// ── State ─────────────────────────────────────────────────────────────────────

test('status() / me() / members() / connection() have the canonical shapes', () => {
  const session = newSession(TMP())
  strictEqual(session.status(), 'notJoined')
  const me = session.me()
  ok(typeof me.id === 'string' && me.id.length > 0)
  ok(typeof me.name === 'string' && me.name.length > 0)
  deepStrictEqualArray(session.members())
  const connection = session.connection()
  ok(typeof connection.state === 'string')
  session.close()
})

function deepStrictEqualArray(value) {
  ok(Array.isArray(value), 'members() returns an array')
  strictEqual(value.length, 0, 'no members before pairing')
}

// ── Receiving ─────────────────────────────────────────────────────────────────

test('onMessage is one-shot, enforced by the CORE', () => {
  const session = newSession(TMP())
  session.onMessage(() => {})
  try {
    session.onMessage(() => {})
    ok(false, 'second registration must throw')
  } catch (err) {
    strictEqual(err.code, 'messageHandlerAlreadySet')
  }
  session.close()
})

test('cancelMessageHandler drops the handler without re-enabling registration', () => {
  const session = newSession(TMP())
  session.onMessage(() => {})
  session.cancelMessageHandler()
  try {
    session.onMessage(() => {})
    ok(false, 'one-shot survives cancel')
  } catch (err) {
    strictEqual(err.code, 'messageHandlerAlreadySet')
  }
  session.close()
})

test('completeMessage with an unknown ack id is a no-op', () => {
  const session = newSession(TMP())
  session.onMessage(() => {})
  session.completeMessage(999999, null)
  session.completeMessage(999999, 'late error')
  session.close()
})

// ── Pairing ───────────────────────────────────────────────────────────────────

test('startPairing() returns a non-empty token', () => {
  const session = newSession(TMP())
  const token = session.startPairing()
  ok(typeof token === 'string' && token.length > 0, `expected token string, got ${token}`)
  session.cancelPairing()
  session.close()
})

// ── close() ───────────────────────────────────────────────────────────────────

test('close() is idempotent; calls after close throw typed closed', () => {
  const session = newSession(TMP())
  session.close()
  session.close()
  try {
    session.status()
    ok(false, 'must throw')
  } catch (err) {
    strictEqual(err.code, 'closed')
  }
})
