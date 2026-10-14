# G12 parity pin — vendored Shared Facts

`shared-facts.json` here is a **byte-exact, SHA-256-pinned copy** of
trueseal-sync's generated `docs/shared-facts.json` — the canonical source of
the error / event / status / reason vocabularies every SDK must match
(docs ADR-0003, sync ADR-0028, release gate G12).

## The pin

- **Upstream:** `julianbonomini/trueseal-sync`, `docs/shared-facts.json`
- **Pinned commit:** `0036f09828e9b6904544ac2b4a2e0b107de022ec`
  (the commit that last touched the file; within the core pin
  `core-rev.txt` = `af16c4e7dbca21e5eaad4a816c2774b9cf8e4d7f`)
- **SHA-256:** `159491b8a563c6928d564458c898e2c5e815e3e291091bc7e6342624031fe62a`
- **sdkVersion:** 0.6.0 (14 errors, 5 events, 5 statuses, 6 status reasons,
  4 connection states, 5 delivery issues, 4 unreadable reasons,
  3 send-failed reasons, 1 admission-drop reason)

`scripts/check-parity.mjs` recomputes the hash on every run and records it in
the G12 report artifact. `.gitattributes` marks `Parity/**` as `-text` so a
Windows checkout can never CRLF-rewrite the pinned bytes (the lesson of
SDK-2's vector pin, #25).

## Updating the pin

Re-pinning is a deliberate act, exactly like bumping `core-rev.txt`:

1. `cp ../trueseal-sync/docs/shared-facts.json Parity/shared-facts.json`
   (from the core commit the repo pins, or a newer one being adopted).
2. Update the commit + SHA-256 above.
3. Run `npm run build && node scripts/check-parity.mjs --self-test` — the
   parity check must pass against the new facts. If the core added or
   renamed a case, the SDK surface changes in the SAME commit (G12: event
   and error cases match across the three SDKs and the core).

The Release Conductor (trueseal-e2e, E2E-8) attaches the report artifact as
Release Evidence; it never updates this pin.
