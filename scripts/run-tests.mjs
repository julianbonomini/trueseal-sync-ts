// TS-2: portable test runner.
//
// `node --test` glob semantics differ by version (Node 20 passes positional
// args to the loader literally; Node 21+ expands globs itself) and by shell
// (npm on Windows uses cmd.exe, which never expands globs), so no glob form
// of the test script works on every matrix leg. This runner enumerates the
// test files itself and invokes node --test with the explicit list — one
// behavior on every platform and every Node version.
//
// Usage: node scripts/run-tests.mjs

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const testsDir = join(root, '__tests__')

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => join(testsDir, f))

if (files.length === 0) {
  console.error(`run-tests: no *.test.mjs files found in ${testsDir}`)
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-force-exit', ...files],
  { stdio: 'inherit' },
)

process.exit(result.status ?? 1)
