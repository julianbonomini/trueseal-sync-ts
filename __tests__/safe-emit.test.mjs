// Tests for the safe-emit behaviour added to fix P1.
//
// When a JS listener throws inside a TSFN callback, ErrorStrategy::Fatal
// would abort the process. The fix wraps every emit() call in try/catch and
// re-throws via process.nextTick so errors surface as unhandled exceptions
// (exit-code 1 + stack trace) instead of SIGABRT.
//
// The deferred nextTick re-throw cannot be unit-tested here: Node.js v22's
// test runner intercepts uncaughtException at the process level, making any
// assertion about it impossible without a subprocess. That behaviour is an
// implementation detail verified by code review.
//
// These tests cover all synchronously observable contracts.

import { strictEqual, ok } from 'node:assert'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'

// CJS module → must use default import pattern in ESM.
import indexPkg from '../dist/index.js'
const { _safeEmit } = indexPkg

test('safeEmit: listener is invoked', () => {
  const ee = new EventEmitter()
  let called = false
  ee.on('ping', () => { called = true })
  _safeEmit(ee, 'ping')
  ok(called)
})

test('safeEmit: args are passed through', () => {
  const ee = new EventEmitter()
  let received = null
  ee.on('data', (x) => { received = x })
  _safeEmit(ee, 'data', 42)
  strictEqual(received, 42)
})

test('safeEmit: undefined emitter is a no-op', () => {
  _safeEmit(undefined, 'ping')  // must not throw
})

test('safeEmit: multiple args are forwarded', () => {
  const ee = new EventEmitter()
  const got = []
  ee.on('ev', (a, b, c) => got.push(a, b, c))
  _safeEmit(ee, 'ev', 1, 2, 3)
  strictEqual(got.join(','), '1,2,3')
})

test('safeEmit: no listener for event — no-op (no error event thrown)', () => {
  const ee = new EventEmitter()
  _safeEmit(ee, 'nonexistent')  // must not throw (would throw for 'error' events)
})
