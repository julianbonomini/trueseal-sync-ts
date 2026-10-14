# @trueseal/sync

> **Developer Preview.** Every package is `0.x` and openly allowed to break — the API,
> the wire format and stored data may change without notice. Each breaking release
> carries upgrade steps. See the
> [preview lifecycle](https://trueseal.dev/agents/developer-preview).

The Node.js / Electron SDK for [TrueSeal](https://trueseal.dev) — end-to-end
encrypted, local-first sync between a group of devices. No accounts. The relay
can't read or forge messages;
[here is exactly what it does see](https://trueseal.dev/agents/threat-model).

An idiomatic TypeScript surface over the Rust core
([trueseal-sync](https://github.com/julianbonomini/trueseal-sync)) — async/await,
typed errors, no FFI types.

**Platforms:** Node.js 20+ on macOS arm64 and x64, Linux x64 and arm64 (glibc), and
Windows x64 — prebuilt per-platform packages (`@trueseal/sync-<platform>`). Linux
musl (e.g. Alpine) and Windows arm64 are not supported; the loader reports them as
unsupported at import time.

---

## Install

```bash
npm install @trueseal/sync
```

The registry publish is landing (tracked as
[OPS-4](https://github.com/julianbonomini/trueseal-e2e/issues/15) — the packages
are structured and install-tested on every platform above). Until then, build from
source — a Rust toolchain (`rustup`) compiles the pinned core, no sibling checkout
needed:

```bash
git clone git@github.com:julianbonomini/trueseal-sync-ts.git && cd trueseal-sync-ts
npm install && npm run build
```

---

## Open

You need a relay — a server that routes encrypted blobs between devices. One Relay
Address string carries its key, host and both ports; the relay CLI prints it
(`trueseal-relay address --host relay.example.com`). To run one, see
[self-hosting](https://trueseal.dev/agents/running-a-relay).

```ts
import { TrueSeal } from '@trueseal/sync'

const ts = await TrueSeal.open(
  'trueseal://<relay public key hex>@relay.example.com',
  { storageDir: '/path/to/your-app/trueseal' },   // scope to YOUR app — see below
)
```

Session State lives under `storageDir` (data at rest is protected by the OS
sandbox). **Scope it to your app** — two apps sharing a path share a group
identity. `open` returns before the connection is up: sends queue in the outbox
and replay once the relay is reachable, and `disconnected` is a normal transient
state, not an error to surface.

---

## Pair two devices

Devices sync within a group. You bootstrap the group by pairing: one device opens
a window and hands over a token; the other joins with it; the first accepts. The
token carries a single-use secret — it does not expire on a timer; the window
closes when the device cancels it or accepts a join.

**Device A** — open the pairing window and get a token (show it as a QR code,
copy it over, etc.):

```ts
const token = tsA.startPairing()
```

**Device B** — join with the token (status becomes `pendingJoin` until the first
manifest arrives):

```ts
tsB.join(token)
```

**Device A** — the request arrives as an event; accept it:

```ts
const sub = tsA.onEvent((event) => {
  if (event.type === 'joinRequest') {
    tsA.accept(event.request.id)   // a name is a label, never authentication
  }
})
```

After `accept`, both devices are members and can send and receive.

---

## Send & receive

```ts
// Send — returns the Message ID once durably queued (fails typed while
// not a member, or over TrueSeal.maxPayloadBytes)
const messageId = ts.send(Buffer.from(JSON.stringify({ type: 'clip', content: 'hello' })))

// Receive — one awaited handler per object; registering it starts receiving
const sub = ts.onMessage(async (message) => {
  console.log(message.id)                        // stable, opaque — never parse it
  console.log(message.from.name)                 // sender, same id as in ts.members
  console.log(JSON.parse(message.body.toString()))
})
```

Delivery is at least once, in per-sender order. The message is acked only after
your handler completes — a throw retries (then a `handlerGaveUp` delivery issue).
Make handling idempotent: persist `message.id` with your app state and ignore
re-deliveries (possible after a crash mid-handling). Return promptly — a handler
parked for more than the core's liveness window stalls delivery and tears the
session down around it; queue long work instead of awaiting it. The same
return-promptly rule applies to `onEvent` / `onDeliveryIssue` listeners.

The object outlives the group: after removal, leave or Destroy Group, the library
wipes the namespace, rotates to a fresh identity, and the same object reaches
`notJoined` and can pair again. Call `ts.close()` when done — it stops the
connection and handlers, keeps Session State, and every later call fails with
typed `closed`.

Every error is a `TrueSealError` with a typed `code` — 14 canonical cases, no
catch-all, identical across all three SDKs.

---

## Reference

This README is a quickstart. The full reference lives in the docs:

- **[Human Docs](https://trueseal.dev/docs/integrate/integrating-trueseal-sync)** —
  integrating TrueSeal, pairing, membership, sending and receiving, errors and
  events
- **[Agent Docs: SDK API reference](https://trueseal.dev/agents/api)** — every
  public type, method, error case and limit, canonical across all three SDKs
  (paste-friendly for coding agents; the
  [Agent Docs tree](https://trueseal.dev/agents/) has the rest)
- **[Threat Model](https://trueseal.dev/agents/threat-model)** — every security
  claim, the tests that prove it, and the limitations
- **[Developer Preview lifecycle](https://trueseal.dev/agents/developer-preview)** —
  version rules and upgrade notes

Security reports: see [SECURITY.md](SECURITY.md). Hacking on the SDK itself:
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
