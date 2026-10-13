// Error-surface semantics.
//
// Two rules, both verified here with injected failures:
//   1. A native error carrying a canonical code is rethrown as a typed
//      TrueSealError (code + typed extras preserved).
//   2. Anything else propagates UNCHANGED. There is no catch-all: an
//      unexpected native failure is a bug, and wrapping it in a typed
//      error would be a lie.

import { ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

import indexPkg from '../dist/index.js'
const { TrueSeal, TrueSealError } = indexPkg

const KEY_HEX = Buffer.alloc(32, 0x01).toString('hex')
const ADDRESS = `trueseal://${KEY_HEX}@127.0.0.1`
const TMP = () => mkdtempSync(join(tmpdir(), 'trueseal-wrap-'))

async function open() {
  return TrueSeal.open(ADDRESS, { storageDir: TMP(), namespace: 'wrap' })
}

// Inject a fake _session method that throws the given value (simulating a
// native throw).
function injectThrow(ts, methodName, thrown) {
  const realSession = ts._session
  const fake = Object.create(realSession)
  fake[methodName] = () => { throw thrown }
  // Native methods need the REAL receiver ("Illegal invocation" otherwise);
  // the fake delegates everything but the injected method.
  fake.close = () => realSession.close()
  Object.defineProperty(ts, '_session', { value: fake, writable: true, configurable: true })
}

test('a native error with a canonical code becomes a typed TrueSealError', async () => {
  const ts = await open()
  const nativeLike = new Error('boom from native')
  nativeLike.code = 'storage'
  injectThrow(ts, 'members', nativeLike)
  try {
    ts.members
    ok(false, 'must throw')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'storage')
    strictEqual(err.message, 'boom from native')
  }
  ts.close()
})

test('typed extras survive the mapping (notMember.status)', async () => {
  const ts = await open()
  const nativeLike = new Error('not a member')
  nativeLike.code = 'notMember'
  nativeLike.status = 'pendingJoin'
  injectThrow(ts, 'send', nativeLike)
  try {
    ts.send(Buffer.from('x'))
    ok(false, 'must throw')
  } catch (err) {
    ok(err instanceof TrueSealError)
    strictEqual(err.code, 'notMember')
    strictEqual(err.status, 'pendingJoin')
  }
  ts.close()
})

test('a native error WITHOUT a canonical code propagates unchanged', async () => {
  const ts = await open()
  const weird = new TypeError('something impossible')
  injectThrow(ts, 'members', weird)
  try {
    ts.members
    ok(false, 'must throw')
  } catch (err) {
    strictEqual(err, weird, 'propagated by identity — not wrapped')
  }
  ts.close()
})

test('a non-Error thrown value propagates unchanged', async () => {
  const ts = await open()
  injectThrow(ts, 'send', 'a string, somehow')
  try {
    ts.send(Buffer.from('x'))
    ok(false, 'must throw')
  } catch (err) {
    strictEqual(err, 'a string, somehow')
  }
  ts.close()
})
