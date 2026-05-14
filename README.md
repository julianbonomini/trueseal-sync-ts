# hush-sync-ts

Node.js / Electron SDK for [hush-sync](https://github.com/julianbonomini/hush-sync) — E2EE, local-first device sync. No accounts, no plaintext on the relay, no lock-in.

---

## Install

> **Requires a Rust toolchain** (`rustup`) — the package compiles a native `.node` binary at install time. Pre-built binaries are planned; see [#prebuilds](https://github.com/julianbonomini/hush-sync-ts/issues).

Both repos must be siblings on disk:

```
hush/
  hush-sync/       ← Rust core
  hush-sync-ts/    ← this package
```

```bash
npm install git+https://github.com/julianbonomini/hush-sync-ts.git
# or from source:
git clone git@github.com:julianbonomini/hush-sync-ts.git && cd hush-sync-ts
npm install && npm run build
```

---

## Quick start

```ts
import { HushSyncClient, HushSyncError } from 'hush-sync-ts'

// ── Create ───────────────────────────────────────────────────────────────────
// Relay connects in the background. Never throws due to relay being unreachable.
const client = await HushSyncClient.create({
  relayHost: 'relay.example.com',
  relayPublicKey: Buffer.from('3f783127c25c91ac8ea02ab97edca78e5708e0c686fa0cc2e714c135c7cd095e', 'hex'),
  storageDir: '/path/to/your-app/hush',   // scope to your app — see Storage below
  namespace: 'default',
})

// ── Pair: Device A (host) ─────────────────────────────────────────────────────
const token = client.pairingToken()       // stable, stateless — cache it
// → show token as QR / AirDrop / paste

client.on('memberRequest', (requestToken, name) => {
  client.acceptPairingRequest(requestToken)
})

// ── Pair: Device B (joiner) ───────────────────────────────────────────────────
client.joinGroup(token)

// ── Both sides ────────────────────────────────────────────────────────────────
client.on('memberJoined', (member) => {
  console.log(`${member.name} joined — id: ${member.id}`)
})

// ── Send + receive ────────────────────────────────────────────────────────────
await client.send(Buffer.from(JSON.stringify({ type: 'clip', content: 'hello' })))

client.on('message', (blob, senderId) => {
  // Dedup at your layer — relay may echo your own sends
  const msg = JSON.parse(blob.toString())
})
```

---

## API

### Config

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `relayHost` | `string` | — | Hostname or IP, no port |
| `relayPublicKey` | `Buffer` | — | 32-byte X25519 key — build-time constant, not user-configurable |
| `storageDir` | `string` | `~/.hush-sync` | **Scope to your app** — see [Storage](#storage) |
| `namespace` | `string` | `"default"` | One session per namespace per `storageDir` |

### Methods

| Method | Returns | Throws | Notes |
|--------|---------|--------|-------|
| `HushSyncClient.create(config)` | `Promise<HushSyncClient>` | `HushSyncError` | Constructor. Relay connects in background. |
| `pairingToken()` | `string` | — | Stable base64url token. Stateless — generate once and cache. |
| `joinGroup(token)` | `void` | `HushSyncError` | Device B calls this with A's token. |
| `acceptPairingRequest(requestToken)` | `boolean` | `HushSyncError` | Device A calls this from `memberRequest` event. |
| `cancelPairing()` | `void` | `HushSyncError` | Close acceptance window without admitting. Call after accepting (single-use). |
| `send(blob)` | `Promise<void>` | `HushSyncError` | Encrypted broadcast to all members. Queues offline; replays on reconnect. |
| `removeMember(id)` | `void` | `HushSyncError` | Soft removal — no key rotation. |
| `destroyGroup()` | `void` | `HushSyncError` | Revokes all members. Session is **terminal** — create a new client after. |
| `dispose()` | `void` | — | Removes all listeners. Idempotent. See [Electron](#electron). |

### Identity (read-only)

| Property | Type | Notes |
|----------|------|-------|
| `localNodeId` | `string` | Stable opaque ID — base64url of first 8 bytes of signing key |
| `localDeviceName` | `string` | Human-readable, e.g. `"AmberFalcon"` — deterministic from keypair |
| `members` | `Member[]` | Remote members only — **local device excluded** |
| `disposed` | `boolean` | `true` after `dispose()` |

### Events

| Event | Payload | When |
|-------|---------|------|
| `message` | `(blob: Buffer, senderId: string)` | Encrypted blob received. `senderId` is base64url noise pubkey. |
| `memberRequest` | `(requestToken: string, name: string)` | Remote device is knocking. Call `acceptPairingRequest(requestToken)` to admit. |
| `memberJoined` | `(member: Member)` | Pairing completed or manifest sync'd a new peer. |
| `memberLeft` | `(member: Member)` | Member was removed. |
| `removedFromGroup` | — | **You** were removed by another member. |
| `groupDestroyed` | — | Any member called `destroyGroup()`. Session is terminal. |
| `connectionChanged` | `(connected: boolean)` | Relay connection state. `false` is normal and transient. |

### Errors

All errors surface as `HushSyncError extends Error`.

| `err.message` | Cause |
|---------------|-------|
| `"not in any group"` | `send()` or `removeMember()` before pairing |
| `"group has been destroyed"` | Operation on a terminal session |
| `"invalid relay public key"` | Wrong byte length passed to `create()` |
| `"invalid pairing token"` | `joinGroup()` received a malformed token |
| `"member not found"` | `removeMember()` with an unknown ID |

---

## Integration notes

These are non-obvious. Get them wrong and things fail quietly.

**Storage — scope to your app.**
Never rely on the default `~/.hush-sync`. Two apps sharing a path share a group identity. Use a path under your app's data directory and create it before passing it to `create()`.

**Startup order matters.**
On boot, call `client.members` before attaching event listeners and seed your member list from the snapshot. If you attach listeners first, you'll miss state that's already persisted.

**Relay offline is not an error.**
`connectionChanged(false)` is a normal transient state. Outbound sends queue in SQLite and replay automatically on reconnect. Do not surface this as a user-facing error or retry logic.

**Dedup self-messages at your layer.**
Depending on relay configuration, `message` may fire for blobs you sent. Check content against your local store before applying.

**`pairingToken()` is stateless.**
The token encodes your permanent keypair — it doesn't open a timed window. UX for how long to accept requests is entirely your responsibility. Call `cancelPairing()` after accepting to enforce single-use.

**`destroyGroup()` is terminal.**
After this fires (on any device), stop all listeners, delete `storageDir`, and call `HushSyncClient.create()` with a fresh storage path to get a new identity.

**Session is a singleton.**
One instance per app lifecycle. Do not create multiple clients against the same `storageDir` + `namespace`.

---

## Electron

TSFNs are `unref()`'d — they never prevent process exit. For explicit teardown on window close:

```ts
// In main process / window lifecycle
mainWindow.on('close', () => client.dispose())

// Or with TC39 'using' (TypeScript 5.2+)
using client = await HushSyncClient.create(config)
```

---

## Testing

Unit tests run without a relay:

```bash
npm test
```

Smoke tests (full pairing flow) need a local relay:

```bash
cd ../hush-relay && ./hush-relay -config relay.toml
RELAY_PUB_KEY=<64-hex> npm test   # override key if needed
SKIP_RELAY_TESTS=1 npm test        # skip smoke tests
```

---

## Further reading

- [hush-sync integration guide](../hush-sync/docs/integrating-hush-sync.md) — concepts, pairing ceremony, session lifecycle, UX patterns
- [hush ecosystem docs](https://hush.dev/docs) — architecture, relay deployment, wire protocol
- [hush-relay](https://github.com/julianbonomini/hush-relay) — run your own relay

---

## License

Apache 2.0
