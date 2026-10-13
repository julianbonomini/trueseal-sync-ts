import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Raw NAPI bindings — never re-exported.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const native = require('../index.js') as typeof import('./native-types.js')

// ── Safe emit ─────────────────────────────────────────────────────────────────

/**
 * Call `ee.emit(event, ...args)` without letting a throwing listener propagate
 * synchronously into a NAPI ThreadsafeFunction callback (which would trigger
 * ErrorStrategy::Fatal and abort the process).
 *
 * If a listener throws, the error is re-thrown on the next event-loop tick so
 * it surfaces as an uncaught exception — stack trace + exit-code 1 — rather
 * than SIGABRT with no context.
 *
 * Exported as `_safeEmit` (underscore = test-only) so the behaviour can be
 * unit-tested without a relay.
 */
export function _safeEmit(
  ee: EventEmitter | undefined,
  event: string | symbol,
  ...args: unknown[]
): void {
  if (!ee) return
  try {
    ee.emit(event, ...args)
  } catch (err) {
    process.nextTick(() => { throw err })
  }
}

// ── Public types ──────────────────────────────────────────────────────────────

/** A remote member of the Sync Group. */
export interface Member {
  /** Stable opaque identifier derived from the member's signing public key. */
  id: string
  /** Auto-generated human-readable name, e.g. "AmberFalcon". */
  name: string
}

/**
 * The group status (ADR-0028). Canonical camelCase codes from
 * trueseal-sync docs/shared-facts.json (`statuses`) — the G12 parity source.
 */
export type GroupStatus =
  | 'notJoined'
  | 'pendingJoin'
  | 'member'
  | 'leaving'
  | 'destroying'

/**
 * The canonical error codes (sync ADR-0028, amended by ADR-0032 and SYNC-15).
 * Exactly 14 cases, character-for-character from trueseal-sync
 * docs/shared-facts.json (`errors`) — the G12 parity source compares them
 * across SDKs. There is NO catch-all: a core error that does not map to one
 * of these is a bug, not a new string to match on.
 */
export type TrueSealErrorCode =
  | 'invalidRelayAddress'
  | 'invalidNamespace'
  | 'storage'
  | 'closed'
  | 'notMember'
  | 'alreadyInGroup'
  | 'invalidPairingToken'
  | 'pairingClosed'
  | 'groupFull'
  | 'memberNotFound'
  | 'payloadTooLarge'
  | 'messageHandlerAlreadySet'
  | 'storeTooNew'
  | 'manifestVersionExhausted'

/**
 * The canonical codes as a runtime list, in shared-facts.json order. The
 * parity test pins this list exactly — a 15th canonical case in the core
 * fails the native build (exhaustive Rust match) and any drift here fails
 * the test.
 */
export const TRUESEAL_ERROR_CODES: readonly TrueSealErrorCode[] = [
  'invalidRelayAddress',
  'invalidNamespace',
  'storage',
  'closed',
  'notMember',
  'alreadyInGroup',
  'invalidPairingToken',
  'pairingClosed',
  'groupFull',
  'memberNotFound',
  'payloadTooLarge',
  'messageHandlerAlreadySet',
  'storeTooNew',
  'manifestVersionExhausted',
]

/** Configuration passed to {@link TruesealSyncClient.create}. */
export interface TruesealSyncConfig {
  /** Relay hostname or IP (no port). */
  relayHost: string
  /** 32-byte X25519 relay public key. */
  relayPublicKey: Buffer
  /**
   * Directory for the SQLite session state database.
   * Defaults to `~/.trueseal-sync`.
   */
  storageDir?: string
  /**
   * Namespace scoping the DB file — one session per namespace per storageDir.
   * Defaults to `"default"`.
   */
  namespace?: string
}

/**
 * Every error the TrueSeal SDK throws (sync ADR-0028, as amended by ADR-0032
 * and SYNC-15). Exactly 14 {@link TrueSealErrorCode} cases, one-to-one with
 * the core — there is no catch-all.
 *
 * Typed extras, present only on the cases that carry them (same shape as the
 * Swift and Kotlin SDKs):
 * - `status`    — `notMember`: the {@link GroupStatus} the call saw
 * - `max`       — `groupFull` / `payloadTooLarge`: the limit that was hit
 * - `found`, `supported` — `storeTooNew`: the on-disk store version and the
 *   highest version this SDK supports
 */
export class TrueSealError extends Error {
  readonly code: TrueSealErrorCode
  readonly status?: GroupStatus
  readonly max?: number
  readonly found?: number
  readonly supported?: number

  constructor(
    code: TrueSealErrorCode,
    message: string,
    extras?: { status?: GroupStatus; max?: number; found?: number; supported?: number },
  ) {
    super(message)
    this.name = 'TrueSealError'
    this.code = code
    if (extras?.status !== undefined) this.status = extras.status
    if (extras?.max !== undefined) this.max = extras.max
    if (extras?.found !== undefined) this.found = extras.found
    if (extras?.supported !== undefined) this.supported = extras.supported
    // Restore prototype chain (required when extending built-ins in TS).
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

const _codeSet: ReadonlySet<string> = new Set(TRUESEAL_ERROR_CODES)

/**
 * Rethrow a native error as a typed {@link TrueSealError} when it carries a
 * canonical code; propagate anything else UNCHANGED. There is deliberately
 * no catch-all mapping — a native failure without a canonical code is not a
 * TrueSealError (the mapping itself lives in Rust, as an exhaustive match).
 */
function rethrowTyped(err: unknown): never {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    if (typeof code === 'string' && _codeSet.has(code)) {
      const e = err as Error & {
        code: string
        status?: unknown
        max?: unknown
        found?: unknown
        supported?: unknown
      }
      throw new TrueSealError(code as TrueSealErrorCode, e.message, {
        status: typeof e.status === 'string' ? (e.status as GroupStatus) : undefined,
        max: typeof e.max === 'number' ? e.max : undefined,
        found: typeof e.found === 'number' ? e.found : undefined,
        supported: typeof e.supported === 'number' ? e.supported : undefined,
      })
    }
  }
  throw err
}

// ── TruesealSyncClient ────────────────────────────────────────────────────────────

/**
 * E2EE, local-first sync client for Node.js and Electron.
 *
 * @example
 * ```ts
 * const client = await TruesealSyncClient.create({
 *   relayHost: 'relay.example.com',
 *   relayPublicKey: Buffer.from('<base64>'),
 * })
 *
 * client.on('message', (blob, senderId, messageId) => console.log('received', messageId, blob))
 * await client.send(Buffer.from('hello'))
 * ```
 */
export declare interface TruesealSyncClient {
  /**
   * A Sync blob was received. `senderId` is the sender's member id (the same
   * id as in {@link TruesealSyncClient.members}). Persist `messageId` with
   * app state to ignore re-delivery after a crash mid-handling.
   *
   * LISTENER SEMANTICS (ADR-0026): the core AWAITS the handler — the relay
   * is acked only after all synchronous listeners return. Return promptly:
   * a listener parked for >75s wedges delivery for every message behind it
   * and the client declares the session dead (the B23c liveness rule);
   * long work belongs in a queue the listener feeds.
   */
  on(event: 'message', listener: (blob: Buffer, senderId: string, messageId: string) => void): this
  /** A new device joined the Sync Group. Return promptly — see 'message'. */
  on(event: 'memberJoined', listener: (member: Member) => void): this
  /** A device was soft-removed from the Sync Group. Return promptly — see 'message'. */
  on(event: 'memberLeft', listener: (member: Member) => void): this
  /** This device was removed from the Sync Group by another member. */
  on(event: 'removedFromGroup', listener: () => void): this
  /** The Sync Group was destroyed. Session is terminal — create a new client to start fresh. */
  on(event: 'groupDestroyed', listener: () => void): this
  /** Relay connection state changed. */
  on(event: 'connectionChanged', listener: (connected: boolean) => void): this
  /**
   * A remote device is requesting to join the Sync Group.
   * Call {@link acceptPairingRequest} with `requestId` to admit it.
   */
  on(event: 'memberRequest', listener: (requestId: string, name: string) => void): this


  off(event: 'message', listener: (blob: Buffer, senderId: string, messageId: string) => void): this
  off(event: 'memberJoined', listener: (member: Member) => void): this
  off(event: 'memberLeft', listener: (member: Member) => void): this
  off(event: 'removedFromGroup', listener: () => void): this
  off(event: 'groupDestroyed', listener: () => void): this
  off(event: 'connectionChanged', listener: (connected: boolean) => void): this
  off(event: 'memberRequest', listener: (requestId: string, name: string) => void): this
}

export class TruesealSyncClient extends EventEmitter {
  private readonly _session: InstanceType<typeof native.CoreSession>
  private _disposed = false

  private constructor(session: InstanceType<typeof native.CoreSession>) {
    super()
    this._session = session
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  /**
   * Create a new client. The relay connects in the background — this never
   * rejects due to the relay being unreachable.
   *
   * Throws typed {@link TrueSealError} (`invalidRelayAddress`,
   * `invalidNamespace`, `storage`, `storeTooNew`) for configuration and
   * store failures.
   */
  static async create(config: TruesealSyncConfig): Promise<TruesealSyncClient> {
    const {
      relayHost,
      relayPublicKey,
      storageDir = join(homedir(), '.trueseal-sync'),
      namespace = 'default',
    } = config

    // Create a temporary emitter ref so closures below can capture `client`
    // via a late-binding wrapper.
    let client: TruesealSyncClient | undefined

    let session: InstanceType<typeof native.CoreSession>
    try {
      session = new native.CoreSession(
        storageDir,
        namespace,
        relayHost,
        relayPublicKey,
        (blob: Buffer, senderId: string, messageId: string) =>
          _safeEmit(client, 'message', blob, senderId, messageId),
        () => _safeEmit(client, 'removedFromGroup'),
        () => _safeEmit(client, 'groupDestroyed'),
        (connected: boolean) => _safeEmit(client, 'connectionChanged', connected),
      )
    } catch (err) {
      rethrowTyped(err)
    }

    client = new TruesealSyncClient(session)
    client._wireCallbacks()
    return client
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  /** Stable opaque identifier for this device (the member id). */
  get localNodeId(): string {
    try {
      return this._session.localNodeId()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /** Auto-generated display name for this device. */
  get localDeviceName(): string {
    try {
      return this._session.localDeviceName()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Group ─────────────────────────────────────────────────────────────────

  /** Current remote group members (excludes this device). */
  get members(): Member[] {
    try {
      return this._session.members()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /** Remove a group member by their `id` from {@link members}. */
  removeMember(memberId: string): void {
    try {
      this._session.removeMember(memberId)
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Pairing ───────────────────────────────────────────────────────────────

  /**
   * Open a pairing window and return an opaque token.
   * Show this to the peer (QR code, AirDrop, etc.) and pass it to their {@link joinGroup}.
   */
  pairingToken(): string {
    try {
      return this._session.pairingToken()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /**
   * Join a group as the responding device using the initiator's token.
   * Throws typed {@link TrueSealError} (`invalidPairingToken`) if the token
   * is malformed or its Pairing Secret was already spent.
   */
  joinGroup(token: string): void {
    try {
      this._session.joinGroup(token)
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /**
   * Register a listener for incoming pairing requests.
   * Call {@link acceptPairingRequest} with `requestId` to admit the device.
   */
  /**
   * Convenience alias for `on('memberRequest', listener)`.
   *
   * A remote device is requesting to join the Sync Group. When the event fires,
   * call {@link acceptPairingRequest} with `requestId` to admit it.
   *
   * Multiple listeners are supported and removable with `off('memberRequest', fn)`.
   */
  onMemberRequest(listener: (requestId: string, name: string) => void): void {
    this.on('memberRequest', listener)
  }

  /**
   * Admit a pending device by the opaque `requestId` from {@link onMemberRequest}.
   *
   * Throws typed {@link TrueSealError} (`pairingClosed`) when the pairing
   * window is closed or the request id is unknown (ADR-0023/0028 — an
   * unaccepted request disappears when the window closes, so an unknown id
   * IS an error in the canonical model; the pre-TS-3 boolean `false` return
   * is gone).
   */
  acceptPairingRequest(requestId: string): void {
    try {
      this._session.acceptMember(requestId)
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /** Close the pairing window without admitting any device. */
  cancelPairing(): void {
    try {
      this._session.cancelPairing()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /**
   * Encrypt `blob` and fan it out to all current Sync Group members.
   * Throws typed {@link TrueSealError}: `payloadTooLarge` (carries `max`) if
   * the body exceeds the Protocol Size Limit, `notMember` (carries `status`)
   * if this device is not currently a member.
   *
   * @note The underlying Rust call is synchronous. The `async` signature is
   * intentional: it future-proofs the API for when `send` is moved off the
   * main thread, and keeps call-site ergonomics consistent with other
   * async-style APIs in trueseal-sync. `await client.send(...)` works correctly
   * and never suspends the event loop.
   *
   * @note The native layer returns the stable Message ID once the message is
   * durably queued; SDK-1 (TS) exposes it on the public signature.
   */
  async send(blob: Buffer): Promise<void> {
    try {
      this._session.send(blob)
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Destroy ───────────────────────────────────────────────────────────────

  /**
   * Destroy the Sync Group — queue a durable, forwarded Revoke to all
   * members (ADR-0029); the wipe fires when the relay has accepted every
   * Revoke. All members receive a `groupDestroyed` event.
   */
  destroyGroup(): void {
    try {
      this._session.destroyGroup()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** `true` after {@link dispose} has been called. */
  get disposed(): boolean {
    return this._disposed
  }

  /**
   * Release client resources:
   * - closes the core session (stops the connection, the receive/pump
   *   threads and the handler; Session State is kept on disk — ADR-0028
   *   `close()`; idempotent)
   * - removes all EventEmitter listeners so no callbacks fire on a
   *   destroyed window or stale context
   * - sets {@link disposed} to `true`
   *
   * After `dispose()`, every call throws typed {@link TrueSealError}
   * (`closed`).
   */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._session.close()
    this.removeAllListeners()
  }

  /** Alias for {@link dispose} — supports the TC39 `using` keyword. */
  [Symbol.dispose](): void {
    this.dispose()
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _wireCallbacks(): void {
    this._session.setOnMemberJoined((id: string, name: string) => {
      _safeEmit(this, 'memberJoined', { id, name })
    })
    this._session.setOnMemberLeft((id: string, name: string) => {
      _safeEmit(this, 'memberLeft', { id, name })
    })
    this._session.setOnMemberRequest((token: string, name: string) => {
      _safeEmit(this, 'memberRequest', token, name)
    })
    // on_message, on_removed_from_group, on_group_destroyed, on_connection_changed
    // are wired at construction time via the native.CoreSession constructor.
  }
}
