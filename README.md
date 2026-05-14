# HushSync Node.js SDK

Idiomatic Node.js / Electron wrapper for the [hush-sync](../hush-sync) Rust library.

E2EE, local-first sync between devices. No raw keys, no Noise Protocol, no TcpStream.

---

## Requirements

- Node.js 18+
- Rust toolchain (`rustup`) — required to build from source
- Sibling `hush-sync` repository checked out (see [Install](#install))

---

## Install

### From source (current)

Both repos must be siblings on disk:

```
hush/
  hush-sync/          ← Rust core (required)
  hush-sync-ts/       ← this repo
```

```bash
git clone git@github.com:julianbonomini/hush-sync-ts.git
cd hush-sync-ts
npm install
npm run build        # compiles Rust → .node binary + TypeScript → dist/
```

> When `hush-sync` goes public, switch to the git dep in `Cargo.toml` and publish to npm.
> Until then: ensure `../hush-sync` is present before running `npm run build`.

### From a GitHub URL (once public)

```bash
npm install git+https://github.com/julianbonomini/hush-sync-ts.git
```

---

## Usage

### 1. Initialise

```ts
import { HushSyncClient } from 'hush-sync-ts'

const client = await HushSyncClient.create({
  relayHost: 'relay.example.com',
  relayPublicKey: Buffer.from('3f783127c25c91ac8ea02ab97edca78e5708e0c686fa0cc2e714c135c7cd095e', 'hex'),
  // storageDir defaults to ~/.hush-sync
  // namespace  defaults to "default"
})
// Relay connects in the background — create() never throws due to relay being unreachable.
```

### 2. Pair two devices

**Device A** — generates a pairing token (show as QR code, AirDrop, etc.):

```ts
const token = clientA.pairingToken()
// display `token` to the user
```

**Device B** — scans the token and requests to join:

```ts
clientB.joinGroup(token)
```

**Device A** — listens for the request and accepts:

```ts
clientA.on('memberRequest', (requestToken, name) => {
  console.log(`Pairing request from: ${name}`)
  clientA.acceptPairingRequest(requestToken)
})
```

> `onMemberRequest(fn)` is a convenience alias for `on('memberRequest', fn)`.

Both sides fire `memberJoined` when pairing completes:

```ts
clientA.on('memberJoined', (member) => console.log(`${member.name} joined`))
clientB.on('memberJoined', (member) => console.log(`${member.name} joined`))
```

### 3. Send a blob

```ts
await client.send(Buffer.from('hello from Mac'))
// or any binary data:
await client.send(myBuffer)
```

### 4. Receive blobs

```ts
client.on('message', (blob, senderId) => {
  console.log('Received from', senderId, ':', blob.toString())
})
```

`senderId` is the sender's noise public key encoded as base64url.

### 5. List and remove members

```ts
const members = client.members
console.log(members.map(m => m.name))  // ["AmberFalcon", "CrimsonOwl"]

client.removeMember(members[0].id)   // Soft Removal — no key rotation
```

### 6. Handle membership events

```ts
client.on('memberJoined',      (member)    => console.log(`${member.name} joined`))
client.on('memberLeft',        (member)    => console.log(`${member.name} left`))
client.on('removedFromGroup',  ()          => console.log('This device was removed'))
client.on('groupDestroyed',    ()          => console.log('Group destroyed — reinitialise'))
client.on('connectionChanged', (connected) => console.log('Relay:', connected ? 'up' : 'down'))
```

### 7. Destroy group (security incident)

```ts
client.destroyGroup()
// All devices receive groupDestroyed.
// Every device rotates keypairs on next HushSyncClient.create().
```

### 8. Dispose (Electron / window teardown)

Call `dispose()` to remove all event listeners and mark the client as spent.
The underlying Rust session is GC’d; TSFNs are already `unref()`’d so they
never prevent process exit.

```ts
// Explicit
client.dispose()

// TC39 'using' keyword (TypeScript 5.2+)
using client = await HushSyncClient.create({ ... })
// client.dispose() called automatically at end of block
```

---

## Error handling

All errors surface as `HushSyncError`, a subclass of `Error`.

```ts
import { HushSyncClient, HushSyncError } from 'hush-sync-ts'

try {
  await client.send(Buffer.from('hello'))
} catch (err) {
  if (err instanceof HushSyncError) {
    console.error('sync error:', err.message)
    // Common messages:
    //   "not in any group"           — send() before pairing
    //   "group has been destroyed"   — session is terminal; create a new client
    //   "invalid relay public key"   — wrong key length passed to create()
    //   "invalid pairing token"      — joinGroup() received malformed token
    //   "member not found"           — removeMember() with unknown id
  }
}
```

---

## Architecture

```
Your App
   │  import { HushSyncClient } from 'hush-sync-ts'
   ▼
HushSyncClient          ← idiomatic TypeScript (src/index.ts → dist/index.js)
   │  require('../index.js')
   ▼
NAPI loader             ← index.js — loads platform .node binary
   │
   ▼
hush-sync-ts.*.node     ← compiled Rust (src/session.rs — NAPI-RS bindings)
   │
   ▼
hush-sync               ← Rust core (HushFfiSession, UniFFI surface)
   │
   ▼
hush-noise              ← Noise Protocol (XX + NK handshakes)
```

No UniFFI types, raw bytes, or Noise Protocol concepts cross the public boundary.

---

## Rebuilding when the Rust core changes

When `hush-sync` (the Rust core) is updated:

```bash
cd hush-sync-ts
npm run build          # recompiles Rust + TypeScript
```

That's it — `npm run build` runs both `napi build --platform --release` (Rust) and `tsc` (TypeScript).

If the `hush-sync` API surface changes (new methods, renamed callbacks), update:
- `src/session.rs` — NAPI glue
- `src/native-types.ts` — internal TypeScript type declarations
- `src/index.ts` — public wrapper API

### Switching from path dep to git dep (before npm publish)

Edit `Cargo.toml`:

```toml
# Dev (path dep — default, requires sibling checkout)
hush-sync = { path = "../hush-sync" }

# Production (git dep — use when repos are public)
# hush-sync = { git = "https://github.com/julianbonomini/hush-sync" }
```

---

## Running tests

```bash
npm test
```

Unit and binding tests run without a relay. Smoke tests (two sessions, full pairing flow) require a local relay:

```bash
# Start the relay (from the hush-relay repo)
cd ../hush-relay && ./hush-relay -config relay.toml

# In another terminal:
cd ../hush-sync-ts && npm test

# Override the relay public key if needed:
RELAY_PUB_KEY=<64-char-hex> npm test

# Skip relay tests explicitly:
SKIP_RELAY_TESTS=1 npm test
```

---

## License

Apache 2.0 — see [LICENSE](LICENSE).
