// SDK-1: the buffered listener fan-out (onEvent / onDeliveryIssue semantics).
//
// Exercised through the test-only `_ListenerFanOut` export so buffering,
// cancellation and throw containment are deterministic without a relay.
// The ADR-0028 rules under test:
//   - items raised before the FIRST listener are buffered and flushed to it
//   - later listeners get live items only (no backlog)
//   - cancel() stops delivery to that listener; other listeners continue
//   - a throwing listener never escapes the dispatcher synchronously (a
//     throw into the native ThreadsafeFunction would abort the process);
//     the error surfaces as an uncaught exception on the next tick
//
// The next-tick re-throw cannot be asserted in-process: Node's test runner
// intercepts uncaughtException and fails any test that triggers one. It is
// asserted in a SUBPROCESS below (exit code 1 + the error on stderr).

import { ok, strictEqual, deepStrictEqual } from 'node:assert'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import indexPkg from '../dist/index.js'
const { _ListenerFanOut } = indexPkg

const __dirname = dirname(fileURLToPath(import.meta.url))

test('items before the first listener are buffered and flushed to it, in order', () => {
  const fanOut = new _ListenerFanOut()
  fanOut.dispatch({ n: 1 })
  fanOut.dispatch({ n: 2 })

  const seen = []
  fanOut.add((item) => seen.push(item))
  deepStrictEqual(seen, [{ n: 1 }, { n: 2 }])

  fanOut.dispatch({ n: 3 })
  deepStrictEqual(seen, [{ n: 1 }, { n: 2 }, { n: 3 }])
})

test('a second listener registered later gets live items only', () => {
  const fanOut = new _ListenerFanOut()
  fanOut.dispatch('a')
  const first = []
  fanOut.add((item) => first.push(item)) // flushes 'a' to first

  const second = []
  fanOut.add((item) => second.push(item)) // no backlog for second

  fanOut.dispatch('b')
  deepStrictEqual(first, ['a', 'b'])
  deepStrictEqual(second, ['b'])
})

test('cancel stops delivery to that listener only; double-cancel is a no-op', () => {
  const fanOut = new _ListenerFanOut()
  const a = []
  const b = []
  const subA = fanOut.add((item) => a.push(item)) // first listener: live mode
  fanOut.add((item) => b.push(item))

  fanOut.dispatch('x')
  subA.cancel()
  subA.cancel()
  fanOut.dispatch('y')
  deepStrictEqual(a, ['x'])
  deepStrictEqual(b, ['x', 'y'])
})

test('once flushed, buffering does not re-arm when all listeners cancel', () => {
  const fanOut = new _ListenerFanOut()
  fanOut.dispatch(1)
  const sub = fanOut.add(() => {})
  sub.cancel()
  fanOut.dispatch(2) // live mode: dropped, not buffered
  const seen = []
  fanOut.add((item) => seen.push(item))
  deepStrictEqual(seen, [])
})

test('SUBPROCESS: a throwing listener surfaces as an uncaught exception (exit 1 + stderr), not a hang or SIGABRT', () => {
  // Throw containment is asserted ONLY in a subprocess: Node's test runner
  // intercepts uncaughtException at the process level and fails any test
  // that triggers one, whatever handlers the test adds.
  const script = `
    const { _ListenerFanOut } = require(${JSON.stringify(join(__dirname, '..', 'dist', 'index.js'))})
    const fanOut = new _ListenerFanOut()
    fanOut.add(() => {})
    fanOut.add(() => { throw new Error('listener boom') })
    const second = []
    fanOut.add((item) => second.push(item))
    fanOut.dispatch('item')
    console.log('dispatch returned normally')
    console.log('later listener still ran:', second.length === 1)
  `
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  ok(result.stdout.includes('dispatch returned normally'), 'dispatch did not throw synchronously')
  ok(result.stdout.includes('later listener still ran: true'), 'a throwing listener does not starve the listeners after it')
  strictEqual(result.status, 1, 'the deferred re-throw exits 1 (an uncaught exception), not SIGABRT (134)')
  ok(result.stderr.includes('listener boom'), 'the listener error is on stderr with its stack')
})
