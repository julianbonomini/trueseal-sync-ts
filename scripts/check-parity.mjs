// SDK-4 (#12): the G12 parity check — the TS SDK's exposed case names vs the
// core's canonical Shared Facts (sync ADR-0028 / docs ADR-0003, gate G12).
// TS-native port of the Swift (scripts/check-parity.py) and Kotlin
// precedents, adapted to this repo's shape: the canonical vocabularies are
// type unions at the API surface with RUNTIME counterparts in
// src/vector-vocabularies.ts (SDK-2) plus the public TRUESEAL_ERROR_CODES
// (TS-3). The check imports the COMPILED lists (dist/) — the same build that
// produces the shipped entrypoint — and compares them against the vendored,
// SHA-256-pinned Parity/shared-facts.json (see Parity/README.md).
//
// ANY drift fails the build: a renamed, missing, extra or duplicated case,
// a missing compiled module, or a facts list that doesn't exist. The
// compile-time `satisfies`/`Exclude<…> extends never` assertions in
// vector-vocabularies.ts already tie the lists to the public type unions;
// this check ties them to the CORE's canonical lists — together the chain is
//   core shared-facts  ==(this check)==  runtime lists  ==(tsc)==  public types
//
// Usage:
//   node scripts/check-parity.mjs                    # compare, human report
//   node scripts/check-parity.mjs --report PATH      # also write the
//                                                    # machine-readable G12
//                                                    # report (Release Evidence)
//   node scripts/check-parity.mjs --self-test        # prove the check can
//                                                    # fail: renamed / missing /
//                                                    # extra mutations must all
//                                                    # be caught (G12 negative test)
//   node scripts/check-parity.mjs --dist PATH        # compiled-output override
//                                                    # (testing)
//
// Requires `npm run build` first (dist/). Pure Node stdlib; no network.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

// Canonical list name -> the runtime export that carries it. One row per
// canonical list in shared-facts.json. A core case with no TS counterpart
// (or vice versa) fails the check — exactly the G12 gate.
const LIST_MAP = {
  errors:               { module: 'index.js',                exportName: 'TRUESEAL_ERROR_CODES' },
  events:               { module: 'vector-vocabularies.js',  exportName: 'EVENT_TYPES' },
  statuses:             { module: 'vector-vocabularies.js',  exportName: 'GROUP_STATUSES' },
  statusReasons:        { module: 'vector-vocabularies.js',  exportName: 'STATUS_REASONS' },
  connectionStates:     { module: 'vector-vocabularies.js',  exportName: 'CONNECTION_STATES' },
  deliveryIssues:       { module: 'vector-vocabularies.js',  exportName: 'DELIVERY_ISSUE_TYPES' },
  unreadableReasons:    { module: 'vector-vocabularies.js',  exportName: 'UNREADABLE_REASONS' },
  sendFailedReasons:    { module: 'vector-vocabularies.js',  exportName: 'SEND_FAILED_REASONS' },
  admissionDropReasons: { module: 'vector-vocabularies.js',  exportName: 'ADMISSION_DROP_REASONS' },
}

class ParityError extends Error {}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function loadSdkLists(distDir) {
  const modules = {}
  for (const { module } of Object.values(LIST_MAP)) {
    if (modules[module]) continue
    const path = join(distDir, module)
    if (!existsSync(path)) {
      throw new ParityError(`compiled module missing: ${module} — run \`npm run build\` first`)
    }
    modules[module] = await import(pathToFileURL(path).href)
  }
  const lists = {}
  for (const [listName, { module, exportName }] of Object.entries(LIST_MAP)) {
    const value = modules[module][exportName]
    if (!Array.isArray(value)) {
      throw new ParityError(`${module} does not export an array named ${exportName}`)
    }
    lists[listName] = [...value]
  }
  return lists
}

async function compare(distDir, factsPath) {
  // Returns { ok, report }. Never throws for drift — drift is data; throws
  // ParityError only for structural problems (missing files/exports).
  const facts = JSON.parse(readFileSync(factsPath, 'utf8'))
  const sdk = await loadSdkLists(distDir)

  const sections = []
  let ok = true
  for (const [listName, { module, exportName }] of Object.entries(LIST_MAP)) {
    const canonical = facts[listName]
    if (!Array.isArray(canonical)) {
      throw new ParityError(`shared-facts.json has no '${listName}' list`)
    }
    const sdkList = sdk[listName]
    const missing = canonical.filter((c) => !sdkList.includes(c))
    const extra = sdkList.filter((s) => !canonical.includes(s))
    const dupes = [...new Set(sdkList.filter((s, i) => sdkList.indexOf(s) !== i))].sort()
    const sectionOk = missing.length === 0 && extra.length === 0 && dupes.length === 0
    ok = ok && sectionOk
    sections.push({
      list: listName,
      export: exportName,
      module: `dist/${module}`,
      canonicalCount: canonical.length,
      sdkCount: sdkList.length,
      missingInSdk: missing,
      extraInSdk: extra,
      duplicateInSdk: dupes,
      ok: sectionOk,
    })
  }

  return {
    ok,
    report: {
      check: 'g12-sdk-parity',
      sdk: 'trueseal-sync-ts',
      facts: {
        path: relative(root, factsPath),
        sha256: sha256File(factsPath),
        sdkVersion: facts.sdkVersion,
      },
      sections,
      ok,
    },
  }
}

function printHuman(report) {
  for (const s of report.sections) {
    const mark = s.ok ? 'ok  ' : 'FAIL'
    let line = `[${mark}] ${s.list.padEnd(22)} ${s.export.padEnd(24)} canonical=${s.canonicalCount} sdk=${s.sdkCount}`
    if (!s.ok) {
      const detail = []
      if (s.missingInSdk.length) detail.push('missing: ' + s.missingInSdk.join(', '))
      if (s.extraInSdk.length) detail.push('extra: ' + s.extraInSdk.join(', '))
      if (s.duplicateInSdk.length) detail.push('duplicate: ' + s.duplicateInSdk.join(', '))
      line += `  (${detail.join('; ')})`
    }
    console.log(line)
  }
  console.log(`facts sha256: ${report.facts.sha256} (sdkVersion ${report.facts.sdkVersion})`)
  console.log('G12 parity: ' + (report.ok ? 'PASS' : 'FAIL'))
}

async function selfTest(distDir, factsPath) {
  // The negative test G12 requires: the check MUST catch a renamed, a
  // missing and an extra case. Each mutation is applied to a temp copy of
  // the compiled output; every one must flip the verdict to FAIL (and the
  // pristine tree must PASS, or the whole exercise is meaningless).
  const pristine = await compare(distDir, factsPath)
  if (!pristine.ok) {
    console.log('self-test: FAIL — the pristine tree does not pass; nothing to mutate against')
    return false
  }

  const vocabPath = join(distDir, 'vector-vocabularies.js')
  const original = readFileSync(vocabPath, 'utf8')
  if (!original.includes("'notJoined'")) {
    console.log("self-test: FAIL — expected 'notJoined' in dist/vector-vocabularies.js; build output drifted")
    return false
  }

  const mutations = {
    'renamed case': original.replace("'notJoined'", "'notJoinedRenamed'"),
    'missing case': original.replace("'notJoined',\n", ''),
    'extra case': original.replace(
      "'notJoined',\n",
      "'notJoined',\n  'anExtraCaseTheCoreDoesNotHave',\n",
    ),
  }

  let allCaught = true
  for (const [name, mutated] of Object.entries(mutations)) {
    if (mutated === original) {
      console.log(`self-test: FAIL — mutation '${name}' did not apply (compiled pattern drifted)`)
      allCaught = false
      continue
    }
    const tmp = mkdtempSync(join(tmpdir(), 'trueseal-parity-selftest-'))
    cpSync(distDir, tmp, { recursive: true })
    writeFileSync(join(tmp, 'vector-vocabularies.js'), mutated)
    // index.js is imported for TRUESEAL_ERROR_CODES; the mutation only
    // touches vector-vocabularies.js, which index.js does not re-export.
    let caughtOk
    try {
      caughtOk = (await compare(tmp, factsPath)).ok
    } catch {
      caughtOk = false
    }
    if (caughtOk) {
      console.log(`self-test: FAIL — mutation '${name}' was NOT caught`)
      allCaught = false
    } else {
      console.log(`self-test: mutation '${name}' correctly caught`)
    }
  }
  return allCaught
}

async function main() {
  const args = process.argv.slice(2)
  const opt = (name) => {
    const i = args.indexOf(name)
    return i === -1 ? null : args[i + 1]
  }
  const distDir = resolve(root, opt('--dist') ?? 'dist')
  const factsPath = resolve(root, opt('--facts') ?? 'Parity/shared-facts.json')
  const reportPath = opt('--report')
  const runSelfTest = args.includes('--self-test')

  if (runSelfTest) {
    process.exit((await selfTest(distDir, factsPath)) ? 0 : 1)
  }

  let result
  try {
    result = await compare(distDir, factsPath)
  } catch (err) {
    if (err instanceof ParityError) {
      console.log(`G12 parity: FAIL — ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  printHuman(result.report)
  if (reportPath) {
    mkdirSync(resolve(reportPath, '..'), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(result.report, null, 2) + '\n')
    console.log(`report written: ${reportPath}`)
  }
  process.exit(result.ok ? 0 : 1)
}

main()
