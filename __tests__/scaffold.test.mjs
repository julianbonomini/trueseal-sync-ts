// RED: proves the native build chain works end-to-end.
// Expects a `version()` export from the compiled .node binary.
import { strictEqual, ok } from 'node:assert'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

test('native .node binary loads', () => {
  // Will throw if the binary hasn't been built yet → RED
  const native = require('../index.js')
  ok(native, 'module loaded')
})

test('version() returns a semver string', () => {
  const { version } = require('../index.js')
  ok(typeof version === 'function', 'version is a function')
  const v = version()
  ok(typeof v === 'string' && v.length > 0, `expected semver string, got ${v}`)
})
