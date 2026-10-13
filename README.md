# @trueseal/sync

Node.js / Electron SDK for [trueseal-sync](https://github.com/julianbonomini/trueseal-sync) — E2EE, local-first device sync. No accounts, no plaintext on the relay, no lock-in.

**Developer Preview** — 0.x. Any release may break the API, the wire format or stored data; breaking releases ship upgrade notes.

---

## Install

> **Not yet published on npm** — the `@trueseal/sync` package and its per-platform binaries are structured and pack-tested (see below), but the registry publish waits on the npm org. Until then, build from source:

```bash
git clone git@github.com:julianbonomini/trueseal-sync-ts.git && cd trueseal-sync-ts
npm install && npm run build
```

Once published:

```bash
npm install @trueseal/sync
```

**Requirements:** Node.js 20 or later.

**Supported platforms** (prebuilt per-platform packages, `@trueseal/sync-<platform>`): macOS arm64 and x64, Linux x64 and arm64 (glibc), Windows x64. Linux **musl** (e.g. Alpine) and Windows **arm64** are **not supported** — the loader reports them as unsupported at import time.

From source, the build needs a Rust toolchain (`rustup`); the core compiles from the pinned git revision in `Cargo.toml` (no sibling checkout needed).

---

## Quick start

```ts
import { TrueSeal, TrueSealError } from '@trueseal/sync'

// ── Open ─────────────────────────────────────────────────────────────────────
// One Relay Address string — the relay's `address` command prints it.
// The relay connects in the background; open never fails for reachability.
const ts = await TrueSeal.open(
  'trueseal://3f783127c25c91ac8ea02ab97edca78e5708e0c686fa0cc2e714c135c7cd095e@relay.example.com',
  { storageDir: '/path/to/your-app/trueseal' },   // scope to your app — see Storage below
)

// ── Pair: Device A (admitter) ────────────────────────────────────────────────
const token = ts.startPairing()        // opens the Pairing Window
// → show token as QR / AirDrop / paste

ts.onEvent((event) => {
  if (event.type === 'joinRequest') {
    ts.accept(event.request.id)        // admit the knocking device
  }
})

// ── Pair: Device B (joiner) ──────────────────────────────────────────────────
ts.join(token)                          // moves to pendingJoin; member when admitted

// ── Both sides ───────────────────────────────────────────────────────────────
ts.onEvent((event) => {
  if (event.type === 'statusChanged' && event.status === 'member') {
    console.log('in the group:', ts.members.map((m) => m.name).join(', '))
  }
})

// ── Send + receive ───────────────────────────────────────────────────────────
ts.onMessage(async (message) => {
  // Awaited: the relay is acked only after this returns. Return promptly —
  // long work belongs in a queue this handler feeds. Delivery is at least
  // once: persist message.id with your app state and ignore re-deliveries.
  const msg = JSON.parse(message.body.toString())
  console.log('from', message.from.name, msg)
})

const messageId = ts.send(Buffer.from(JSON.stringify({ type: 'clip', content: 'hello' })))
```

---

## API

### `TrueSeal.open(relay, options?)` → `Promise<TrueSeal>`

`relay` is the Relay Address string (`trueseal://<relay public key hex>@host[:receivePort][?push=pushPort]`) or the typed `RelayAddress` form. The ports default to 7700/7701 and are never dropped silently.

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `storageDir` | `string` | `~/.trueseal-sync` | **Scope to your app** — see Storage below |
| `namespace` | `string` | `"default"` | One session per namespace per `storageDir` |
| `maxPayloadBytes` | `number` | `61440` | Creation-time limit; can only lower the Protocol Size Limit |

### State (getters, fresh from the core on every read)

| Getter | Type | Notes |
|--------|------|-------|
| `status` | `GroupStatus` | `notJoined \| pendingJoin \| member \| leaving \| destroying` |
| `me` | `Member` | This device's `{id, name}` |
| `members` | `Member[]` | Remote members only — the local device excluded |
| `connection` | `ConnectionState` | `connecting \| connected \| disconnected \| relayVersionUnsupported{min,max}` |

### Methods

| Method | Returns | Notes |
|--------|---------|-------|
| `send(body)` | `string` | The MessageId, once the message is durably in the outbox. Queues offline; replays on reconnect. `notMember{status}` / `payloadTooLarge{max}`. |
| `onMessage(handler)` | `Subscription` | THE message handler — async and awaited. One-shot: a second call fails with `messageHandlerAlreadySet`. Registering starts receiving. |
| `onEvent(listener)` | `Subscription` | The canonical event stream (below). Any number of listeners; events before the first are buffered. |
| `onDeliveryIssue(listener)` | `Subscription` | Optional typed delivery-problem stream. |
| `startPairing()` | `string` | Opens the Pairing Window; returns the token. No expiry timer — close it with `cancelPairing()`. |
| `accept(requestId)` | `void` | Admit from a `joinRequest` event. `pairingClosed` / `groupFull{max}`. |
| `cancelPairing()` | `void` | Close the window without admitting. |
| `join(token)` | `void` | Join as the responding device. `alreadyInGroup` / `invalidPairingToken`. |
| `cancelJoin()` | `void` | Abandon a Pending Join; back to `notJoined`. |
| `remove(memberId)` | `void` | Remove a member; their library wipes and rotates automatically. `memberNotFound`. |
| `leave()` | `void` | Move through `leaving` to `notJoined` (reason `left`). |
| `destroyGroup()` | `void` | Durable, forwarded Revoke to all members (see below). |
| `close()` | `void` | Stop the connection and handlers; keep Session State. Idempotent. After it, every call throws `closed`. |

Every `on…` returns a `Subscription`; `cancel()` stops that listener. Cancelling the message handler does NOT re-enable registration (one-shot per object).

### Events (`onEvent`)

| `event.type` | Payload | When |
|--------------|---------|------|
| `statusChanged` | `status`, `reason` | Asynchronous transitions only: `member/created`, `member/joined`, `notJoined/left\|removed\|destroyed\|storeReset`. Synchronous transitions (`join`, `leave`, `destroyGroup`) raise no event — learn them from the call and the `status` getter. |
| `membersChanged` | `members` | The whole current member list, not a delta. |
| `joinRequest` | `request: {id, name}` | A device knocked inside the open window. `accept(request.id)` to admit. A name is never authentication. |
| `connectionChanged` | `connection` | The relay link transitioned. `disconnected` is normal and transient. |
| `admissionDropped` | `name`, `reason` | A pending admission was dropped during concurrent membership changes. |

### Delivery issues (`onDeliveryIssue`)

Optional — the library already does the right thing. Cases: `unreadable{reason}` (`malformed \| senderOutdated \| expired \| droppedWhileHeld`), `unauthorized`, `heldForUpgrade{version}`, `handlerGaveUp{messageId, error}`, `sendFailed{messageId, reason}` (`tooLarge \| malformed \| expired`).

### Errors

All errors are `TrueSealError extends Error` with a typed `code` — exactly 14
canonical cases (no catch-all), matching the Swift and Kotlin SDKs
character-for-character:

`invalidRelayAddress` · `invalidNamespace` · `storage` · `closed` · `notMember{status}` · `alreadyInGroup` · `invalidPairingToken` · `pairingClosed` · `groupFull{max}` · `memberNotFound` · `payloadTooLarge{max}` · `messageHandlerAlreadySet` · `storeTooNew{found, supported}` · `manifestVersionExhausted`

### Statics

`TrueSeal.info` (`{sdkVersion, transportVersion, endToEndVersion}`) · `TrueSeal.maxPayloadBytes` (61,440) · `TrueSeal.maxGroupSize` (32) · `TrueSeal.parseRelayAddress(input)` → `RelayAddress` (`invalidRelayAddress` on malformed input).

---

## Integration notes

These are non-obvious. Get them wrong and things fail quietly.

**Storage — scope to your app.**
Never rely on the default `~/.trueseal-sync`. Two apps sharing a path share a group identity. Use a path under your app's data directory.

**The object outlives the group.**
After removal, leave or Destroy Group the library wipes the namespace, rotates to a fresh identity and the SAME object reaches `notJoined` and can pair again. No rebuild code.

**Relay offline is not an error.**
`disconnected` is a normal transient state. Outbound sends queue in SQLite and replay automatically on reconnect. Do not surface it as a user-facing error or retry loop.

**Make message handling idempotent.**
Delivery is at least once, so the same message can arrive again after a crash mid-handling. Persist `message.id` in the same transaction as your application update; if that ID already exists, ignore the duplicate. Treat the ID as opaque; never parse it.

**Return from the message handler promptly.**
The core awaits the handler before acking, and a handler parked for more than ~75 seconds wedges delivery for everything behind it and the client declares the session dead. Queue long work; don't await it in the handler.

**One session per storageDir + namespace.**
Do not open two `TrueSeal` objects against the same store.

---

## Electron

TSFNs are `unref()`'d — they never prevent process exit. For explicit teardown on window close:

```ts
mainWindow.on('close', () => ts.close())

// Or with TC39 'using' (TypeScript 5.2+)
using ts = await TrueSeal.open(relay, options)
```

---

## Testing

Unit tests run without a relay:

```bash
npm test
```

Smoke tests (full pairing flow) need a local relay:

```bash
cd ../trueseal-relay && TRUESEAL_RELAY_KEYPAIR_PATH=/tmp/relay/keypair.hex TRUESEAL_RELAY_STORE_SQLITE_PATH=/tmp/relay/inbox.db ./trueseal-relay
RELAY_PUB_KEY=<64-hex> npm test   # the relay's `pubkey` command prints it
SKIP_RELAY_TESTS=1 npm test        # skip smoke tests
```

---

## Further reading

- [trueseal ecosystem docs](https://trueseal.dev/docs) — architecture, pairing, delivery, relay deployment
- [trueseal-relay](https://github.com/julianbonomini/trueseal-relay) — run your own relay

---

## License

Apache 2.0
