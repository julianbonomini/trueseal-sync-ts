// TEMPORARY — TS-2 criterion 3 provenance: a deliberately failing test to
// prove CI goes red on a failing PR. Reverted in the next commit.
import { strictEqual } from 'node:assert'
import { test } from 'node:test'

test('ci red probe: deliberately fails', () => {
  strictEqual(1, 2, 'intentional failure — proves the matrix reports red')
})
