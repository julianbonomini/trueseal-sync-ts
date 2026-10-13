// TS-2: surfaces skipped tests in CI instead of letting them pass silently.
//
// Reads the captured `node --test` output, extracts the skipped count and the
// per-test skip lines, and reports them three ways:
//   1. a GitHub Actions job summary (when GITHUB_STEP_SUMMARY is set),
//   2. a ::notice annotation on the run,
//   3. stdout for the raw log.
//
// A skip is an expected state today (the relay-backed smoke tests skip without
// a relay — relay flows belong to trueseal-e2e), so this NEVER fails the job;
// it only makes the skip impossible to miss. A suite that fails is already red
// before this script runs.
//
// Usage: node scripts/report-skips.mjs <test-output-file>

import { readFileSync, appendFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/report-skips.mjs <test-output-file>')
  process.exit(2)
}

let output
try {
  output = readFileSync(file, 'utf8')
} catch (err) {
  console.log(`::warning::report-skips: could not read ${file}: ${err.message}`)
  process.exit(0) // never fail the job on reporting
}

// node --test (spec reporter) summary line: "ℹ skipped N"
const summaryMatch = output.match(/^ℹ skipped (\d+)$/m)
const skipped = summaryMatch ? Number(summaryMatch[1]) : null

// Per-test skip lines: "﹣ <name> (<ms>) # <reason>" or TAP "ok N - <name> # SKIP <reason>"
const skipLines = output
  .split('\n')
  .filter((l) => l.includes('﹣') || /# SKIP/i.test(l))
  .map((l) => l.trim())

if (skipped === null) {
  console.log('::warning::report-skips: no "ℹ skipped N" summary found in the test output — the reporter format may have changed')
  process.exit(0)
}

const headline =
  skipped === 0
    ? 'Test skips: none — every registered test ran.'
    : `Test skips: ${skipped} test(s) skipped (expected without a relay — relay-backed flows run in trueseal-e2e):`

console.log(`::notice::${headline}`)
console.log(headline)
for (const line of skipLines) console.log(`  ${line}`)

if (process.env.GITHUB_STEP_SUMMARY) {
  const body = [
    `### ${headline}`,
    '',
    ...skipLines.map((l) => `- \`${l}\``),
    '',
  ].join('\n')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, body)
}
