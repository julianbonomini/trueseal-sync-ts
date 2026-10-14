// SDK-2 (#10): check the sync JSON test vectors THROUGH the TS bindings —
// release gate G5. The vendored, pinned file proves the shipped prebuilt
// .node binaries and the generated NAPI glue recognise the same wire reality
// as the Rust reference, instead of inferring compatibility from package
// versions (ADR-0022). Consumption contract:
// trueseal-sync/docs/test-vectors/README.md. Mirrors the Swift (swift#13)
// and Kotlin (kotlin#16) precedents.
//
// What is reachable through the public TS surface, and how it is checked:
//   - protocol constants: compared against the linked core's FFI statics
//     (TrueSeal.info / maxPayloadBytes / maxGroupSize), with a negative
//     control (a mutated vector MUST fail).
//   - the rejection taxonomy: every expected typed error / Delivery Issue
//     (+ UnreadableReason) / Connection State name must exist in the SDK's
//     canonical surface. TS exposes those vocabularies as type unions, so
//     the runtime lists live in src/vector-vocabularies.ts with `satisfies`
//     + Exclude-based exhaustiveness assertions — a renamed or missing case
//     fails `tsc` on every matrix leg (the TS analog of the precedents'
//     compile-time case references).
//   - the size rejection: behaviorally, relay-free — the core consults the
//     size gate FIRST (ADR-0025), so a non-member's send(limit+1) throws
//     payloadTooLarge carrying the vector's exact limit, and send(limit)
//     passes the size gate and fails on the next one (notMember).
// The remaining sections pin bytes the public FFI deliberately does not
// expose entry points for (SYNC-2 shipped no test-only FFI hooks); they are
// asserted present and their owning checker is named — faking access would
// violate G5's purpose. Inbound rejection BEHAVIORS (held/older/expired
// envelopes) need a hostile peer: the e2e Adversary Client (G3).

import { ok, strictEqual, deepStrictEqual } from 'node:assert'
import { test } from 'node:test'
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import indexPkg from '../dist/index.js'
const { TrueSeal, TrueSealError, TRUESEAL_ERROR_CODES } = indexPkg

// The runtime taxonomy lists, tied to the public unions at compile time
// (satisfies + exhaustiveness assertions — see src/vector-vocabularies.ts).
const require = createRequire(import.meta.url)
const vocab = require('../dist/vector-vocabularies.js')

// ── The pin (G8) ────────────────────────────────────────────────────────────
// The same upstream commit + SHA-256 the relay (internal/vectors), the Swift
// SDK and the Kotlin SDK pin against. A byte of drift — accidental or
// copied-in — fails the load before any check runs. Do NOT re-pin to silence
// a drift failure: an unexpected drift is a wire-format bug.
const SYNC_V1_SOURCE = 'trueseal-sync@265f99f docs/test-vectors/sync-v1.json'
const SYNC_V1_FORMAT_VERSION = 1
const SYNC_V1_SHA256 = '0506d5a80a9485f612d4d38a2530b70296a1e022e0539f3a001b6298a3dc3b37'

const VECTORS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'vectors',
  'sync-v1.json',
)

class VectorError extends Error {}

function drift(found) {
  return new VectorError(
    `vendored sync-v1.json SHA-256 ${found} != pinned ${SYNC_V1_SHA256} — the file drifted from ` +
      `${SYNC_V1_SOURCE}. Do NOT re-pin to silence this: an unexpected drift is a wire-format bug.`,
  )
}

function loadVectors() {
  if (!existsSync(VECTORS_PATH)) {
    throw new VectorError(
      `sync-v1.json missing at ${VECTORS_PATH} — the vector file MUST be present ` +
        '(issue #10: fail the build on missing vector files)',
    )
  }
  const bytes = readFileSync(VECTORS_PATH)
  const found = createHash('sha256').update(bytes).digest('hex')
  if (found !== SYNC_V1_SHA256) throw drift(found)
  const root = JSON.parse(bytes.toString('utf8'))
  if (root.format !== 'trueseal-sync-vectors' || root.formatVersion !== SYNC_V1_FORMAT_VERSION) {
    throw new VectorError('sync-v1.json malformed: unexpected format/formatVersion')
  }
  return root
}

// ── protocol: versions and limits through the bindings ─────────────────────

// The comparison, factored so the negative control can feed it a mutated
// copy. Returns the list of mismatches (empty = pass). Every value on the
// right is the LINKED CORE's FFI static reached through the public SDK
// surface — a through-the-bindings check, not a re-implementation.
function protocolMismatches(v) {
  const p = v.protocol
  if (p === undefined) throw new VectorError('sync-v1.json malformed: missing protocol section')
  const failures = []
  const expect = (key, actual, surface) => {
    if (p[key] === undefined) {
      failures.push(`protocol.${key} missing from the vector file`)
    } else if (p[key] !== actual) {
      failures.push(`protocol.${key}: bindings report ${actual}, vectors pin ${p[key]} (${surface})`)
    }
  }
  expect('transportVersion', TrueSeal.info.transportVersion, 'TrueSeal.info.transportVersion')
  expect('endToEndVersion', TrueSeal.info.endToEndVersion, 'TrueSeal.info.endToEndVersion')
  expect('protocolSizeLimit', TrueSeal.maxPayloadBytes, 'TrueSeal.maxPayloadBytes')
  expect('maxGroupSize', TrueSeal.maxGroupSize, 'TrueSeal.maxGroupSize')
  return failures
}

test('protocol versions and limits match through the bindings', () => {
  const failures = protocolMismatches(loadVectors())
  deepStrictEqual(failures, [])
})

// Negative control (issue #10): a mutated vector MUST fail the check. Proves
// the comparisons above are real, not tautological.
test('a mutated vector fails the check (negative control)', () => {
  const v = loadVectors()
  const mutated = { ...v, protocol: { ...v.protocol, maxGroupSize: v.protocol.maxGroupSize + 1 } }
  const failures = protocolMismatches(mutated)
  ok(
    failures.some((f) => f.includes('maxGroupSize')),
    `mutation did not produce a maxGroupSize mismatch: ${JSON.stringify(failures)}`,
  )
})

// ── rejections: the canonical taxonomy through the bindings ────────────────

test('every rejection expected name exists in the SDK surface', () => {
  const v = loadVectors()
  ok(Array.isArray(v.rejections) && v.rejections.length > 0, 'missing/empty rejections')

  const errorCodes = new Set(TRUESEAL_ERROR_CODES)
  const issueTypes = new Set(vocab.DELIVERY_ISSUE_TYPES)
  const unreadableReasons = new Set(vocab.UNREADABLE_REASONS)
  const connectionStates = new Set(vocab.CONNECTION_STATES)

  const failures = []
  for (const r of v.rejections) {
    const label = `${r.layer}/${r.case}`
    const expect = r.expect
    if (typeof r.layer !== 'string' || typeof r.case !== 'string' || expect === undefined) {
      failures.push(`malformed rejection entry: ${JSON.stringify(r)}`)
      continue
    }
    switch (expect.kind) {
      case 'typedError':
        if (!errorCodes.has(expect.name)) {
          failures.push(`${label}: typed error '${expect.name}' has no TRUESEAL_ERROR_CODES entry`)
        }
        break
      case 'deliveryIssue':
        if (expect.name === 'unreadable') {
          if (!unreadableReasons.has(expect.reason)) {
            failures.push(`${label}: unreadable reason '${expect.reason}' has no UnreadableReason case`)
          }
        } else if (!issueTypes.has(expect.name)) {
          failures.push(`${label}: delivery issue '${expect.name}' has no DeliveryIssue case`)
        }
        break
      case 'connectionState':
        if (!connectionStates.has(expect.name)) {
          failures.push(`${label}: connection state '${expect.name}' has no ConnectionState case`)
        }
        break
      case 'connectionFailure':
        // The typed disconnected/connectionFailed path — no payload name to
        // pin; 'disconnected' is asserted via connectionStates above.
        break
      default:
        failures.push(`${label}: unknown expect.kind '${expect.kind}' — a new rejection kind the SDK's surface must name`)
    }
  }
  deepStrictEqual(failures, [])
})

// ── the size rejection, behaviorally through the bindings ──────────────────

test('size rejection: send(limit+1) refuses with the vector\'s exact limit, relay-free', async () => {
  const v = loadVectors()
  const limit = v.protocol?.protocolSizeLimit
  strictEqual(typeof limit, 'number', 'missing protocol.protocolSizeLimit')

  // Internal consistency of the vector's own rejection entry.
  const sizeEntry = (v.rejections ?? []).find((r) => r.case === 'bodyOverProtocolLimit')
  ok(sizeEntry, 'size rejection entry missing from the vectors')
  strictEqual(sizeEntry.expect.name, 'payloadTooLarge')
  strictEqual(sizeEntry.expect.max, limit)
  strictEqual(sizeEntry.input.bodyLen, limit + 1)

  const keyHex = Buffer.alloc(32, 0x01).toString('hex')
  const ts = await TrueSeal.open(`trueseal://${keyHex}@127.0.0.1:9?push=9`, {
    storageDir: mkdtempSync(join(tmpdir(), 'trueseal-vectors-')),
    namespace: 'vectors',
  })
  try {
    // Over the limit: typed refusal carrying the vector's exact max —
    // through the public send(), against the shipped native library. The
    // size gate fires BEFORE membership (ADR-0025), so no relay is needed.
    try {
      ts.send(Buffer.alloc(limit + 1))
      ok(false, 'send(limit+1) must throw payloadTooLarge (ADR-0025; vector size/bodyOverProtocolLimit)')
    } catch (err) {
      ok(err instanceof TrueSealError)
      strictEqual(err.code, 'payloadTooLarge')
      strictEqual(err.max, limit, 'payloadTooLarge.max must be the vector\'s protocolSizeLimit')
    }
    // At the limit: the size gate passes; the next gate (membership) fires
    // instead — pinning size-before-membership from the other side.
    try {
      ts.send(Buffer.alloc(limit))
      ok(false, 'at-limit body passes the size gate (then fails notMember offline)')
    } catch (err) {
      strictEqual(err.code, 'notMember', `expected notMember after the size gate passed; got ${err.code ?? err}`)
    }
  } finally {
    ts.close()
  }
})

// ── core-internal sections: present, and their checker named ───────────────

test('core-internal sections are present and their checker is named', () => {
  const v = loadVectors()
  // section → where it is checked. These pin bytes the public FFI
  // deliberately does not expose (signing inputs, seal/open, the message
  // codec, frame assembly): SYNC-2 shipped no test-only FFI hooks, so the
  // owner named here checks them — this test asserts the sections cannot
  // silently vanish from the file every consumer pins.
  const owners = [
    ['domains', 'core: vectors::generated_vectors_verify_against_the_code'],
    ['transportVersionPrefix', 'relay: internal/vectors vectors_test.go (RELAY-5) + core vectors test'],
    ['signing', 'core: vectors test (signing_message / signing_message_for are the signer\'s own functions)'],
    ['addressedEncryption', 'core: vectors test (seal/open round-trip with fixed ephemeral)'],
    ['messageId', 'core: vectors test (tsm1_ derivation)'],
    ['messages', 'core: vectors test (real message codec, incl. the 65-byte pre-SYNC-3 Pair refusal)'],
    ['sealedEnvelope', 'core: vectors test (build_sealed_with_ephemeral; prefix is the decrypted payload)'],
    ['frames', 'relay: vectors_test.go byte-for-byte (RELAY-5) + core vectors test'],
  ]
  for (const [section, owner] of owners) {
    ok(
      v[section] !== undefined && Object.keys(v[section]).length > 0,
      `core-internal section '${section}' is MISSING or empty in the pinned vectors — was it removed upstream? (checked by ${owner})`,
    )
  }
  // The remaining protocol fields the FFI does not expose — presence
  // asserted so the coverage map is complete.
  for (const key of [
    'storeVersion',
    'maxEnvelopeBytes',
    'noiseFramePlaintextMax',
    'maxManifestVersionJump',
    'maxHeldBlobs',
    'replayWindowMs',
  ]) {
    ok(v.protocol[key] !== undefined, `protocol.${key} missing`)
  }
})

// ── machine-readable report (Release Evidence, G5) ──────────────────────────

test('emit the G5 report ($TRUSEAL_VECTOR_REPORT when set)', () => {
  // Deterministic, re-derived entries — independent of test execution order.
  const entries = [
    { section: 'pin', status: 'checked-through-bindings',
      detail: `${SYNC_V1_SOURCE}; sha256 ${SYNC_V1_SHA256}; drift-refusing load` },
    { section: 'protocol', status: 'checked-through-bindings',
      detail: 'transportVersion/endToEndVersion/protocolSizeLimit/maxGroupSize via TrueSeal.info/maxPayloadBytes/maxGroupSize (the linked core\'s FFI statics)' },
    { section: 'rejections (taxonomy)', status: 'checked-through-bindings',
      detail: 'every expected typed error / DeliveryIssue(+reason) / ConnectionState exists in the SDK surface (runtime lists tied to the public unions via satisfies + exhaustiveness assertions in src/vector-vocabularies.ts)' },
    { section: 'rejections/size (behavioral)', status: 'checked-through-bindings',
      detail: 'send(limit+1) throws payloadTooLarge(max: <vector limit>) relay-free; send(limit) passes the size gate (fails notMember offline); size-before-membership pinned both ways' },
    { section: 'negative control', status: 'checked-through-bindings',
      detail: 'a mutated protocol expectation fails the check' },
  ]
  for (const [section, owner] of [
    ['domains', 'core vectors test'],
    ['transportVersionPrefix', 'relay vectors_test.go + core'],
    ['signing', 'core vectors test'],
    ['addressedEncryption', 'core vectors test'],
    ['messageId', 'core vectors test'],
    ['messages', 'core vectors test'],
    ['sealedEnvelope', 'core vectors test'],
    ['frames', 'relay vectors_test.go + core'],
    ['protocol (remaining fields)', 'core vectors test'],
    ['rejections (inbound behaviors: held/older/expired/malformed envelopes)', 'e2e Adversary Client (G3) — needs a hostile peer'],
  ]) {
    entries.push({ section, status: 'documented-core-internal', detail: `checked by ${owner}` })
  }

  const doc = {
    gate: 'G5',
    sdk: 'trueseal-sync-ts',
    pin: { source: SYNC_V1_SOURCE, sha256: SYNC_V1_SHA256, formatVersion: SYNC_V1_FORMAT_VERSION },
    checks: entries,
  }
  const text = JSON.stringify(doc, null, 2)
  console.log(`TRUSEAL-G5-REPORT: ${text}`)
  const path = process.env.TRUSEAL_VECTOR_REPORT
  if (path) writeFileSync(path, text)
})
