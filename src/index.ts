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

/** Configuration passed to {@link HushSyncClient.create}. */
export interface HushSyncConfig {
  /** Relay hostname or IP (no port). */
  relayHost: string
  /** 32-byte X25519 relay public key. */
  relayPublicKey: Buffer
  /**
   * Directory for the SQLite session state database.
   * Defaults to `~/.hush-sync`.
   */
  storageDir?: string
  /**
   * Namespace scoping the DB file — one session per namespace per storageDir.
   * Defaults to `"default"`.
   */
  namespace?: string
}

/** Error thrown by {@link HushSyncClient} operations. */
export class HushSyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HushSyncError'
    // Restore prototype chain (required when extending built-ins in TS).
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ── HushSyncClient ────────────────────────────────────────────────────────────

/**
 * E2EE, local-first sync client for Node.js and Electron.
 *
 * @example
 * ```ts
 * const client = await HushSyncClient.create({
 *   relayHost: 'relay.example.com',
 *   relayPublicKey: Buffer.from('<base64>'),
 * })
 *
 * client.on('message', (blob, senderId) => console.log('received', blob))
 * await client.send(Buffer.from('hello'))
 * ```
 */
export declare interface HushSyncClient {
  /** A Sync blob was received. `senderId` is the sender's noise public key as base64url. */
  on(event: 'message', listener: (blob: Buffer, senderId: string) => void): this
  /** A new device joined the Sync Group. */
  on(event: 'memberJoined', listener: (member: Member) => void): this
  /** A device was soft-removed from the Sync Group. */
  on(event: 'memberLeft', listener: (member: Member) => void): this
  /** This device was removed from the Sync Group by another member. */
  on(event: 'removedFromGroup', listener: () => void): this
  /** The Sync Group was destroyed. Session is terminal — create a new client to start fresh. */
  on(event: 'groupDestroyed', listener: () => void): this
  /** Relay connection state changed. */
  on(event: 'connectionChanged', listener: (connected: boolean) => void): this

  off(event: 'message', listener: (blob: Buffer, senderId: string) => void): this
  off(event: 'memberJoined', listener: (member: Member) => void): this
  off(event: 'memberLeft', listener: (member: Member) => void): this
  off(event: 'removedFromGroup', listener: () => void): this
  off(event: 'groupDestroyed', listener: () => void): this
  off(event: 'connectionChanged', listener: (connected: boolean) => void): this
}

export class HushSyncClient extends EventEmitter {
  private readonly _session: InstanceType<typeof native.HushSession>
  private _disposed = false

  private constructor(session: InstanceType<typeof native.HushSession>) {
    super()
    this._session = session
  }

  // ── Factory ───────────────────────────────────────────────────────────────

  /**
   * Create a new client. The relay connects in the background — this never
   * rejects due to the relay being unreachable.
   */
  static async create(config: HushSyncConfig): Promise<HushSyncClient> {
    const {
      relayHost,
      relayPublicKey,
      storageDir = join(homedir(), '.hush-sync'),
      namespace = 'default',
    } = config

    // Create a temporary emitter ref so closures below can capture `client`
    // via a late-binding wrapper.
    let client: HushSyncClient | undefined

    let session: InstanceType<typeof native.HushSession>
    try {
      session = new native.HushSession(
        storageDir,
        namespace,
        relayHost,
        relayPublicKey,
        (blob: Buffer, senderId: string) => _safeEmit(client, 'message', blob, senderId),
        () => _safeEmit(client, 'removedFromGroup'),
        () => _safeEmit(client, 'groupDestroyed'),
        (connected: boolean) => _safeEmit(client, 'connectionChanged', connected),
      )
    } catch (err) {
      throw new HushSyncError(String(err instanceof Error ? err.message : err))
    }

    client = new HushSyncClient(session)
    client._wireCallbacks()
    return client
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  /** Stable opaque identifier for this device. */
  get localNodeId(): string {
    return this._session.localNodeId()
  }

  /** Auto-generated display name for this device. */
  get localDeviceName(): string {
    return this._session.localDeviceName()
  }

  // ── Group ─────────────────────────────────────────────────────────────────

  /** Current remote group members (excludes this device). */
  get members(): Member[] {
    return this._session.members()
  }

  /** Remove a group member by their `id` from {@link members}. */
  removeMember(memberId: string): void {
    try {
      this._session.removeMember(memberId)
    } catch (err) {
      throw new HushSyncError(String(err instanceof Error ? err.message : err))
    }
  }

  // ── Pairing ───────────────────────────────────────────────────────────────

  /**
   * Open a pairing window and return an opaque token.
   * Show this to the peer (QR code, AirDrop, etc.) and pass it to their {@link joinGroup}.
   */
  pairingToken(): string {
    return this._session.pairingToken()
  }

  /**
   * Join a group as the responding device using the initiator's token.
   * Throws {@link HushSyncError} if the token is malformed.
   */
  joinGroup(token: string): void {
    try {
      this._session.joinGroup(token)
    } catch (err) {
      throw new HushSyncError(String(err instanceof Error ? err.message : err))
    }
  }

  /**
   * Register a listener for incoming pairing requests.
   * Call {@link acceptPairingRequest} with `requestToken` to admit the device.
   */
  onMemberRequest(listener: (requestToken: string, name: string) => void): void {
    this._session.setOnMemberRequest(listener)
  }

  /** Admit a pending device by the opaque `requestToken` from {@link onMemberRequest}. */
  acceptPairingRequest(requestToken: string): boolean {
    try {
      return this._session.acceptMember(requestToken)
    } catch (err) {
      throw new HushSyncError(String(err instanceof Error ? err.message : err))
    }
  }

  /** Close the pairing window without admitting any device. */
  cancelPairing(): void {
    try {
      this._session.cancelPairing()
    } catch (err) {
      throw new HushSyncError(String(err instanceof Error ? err.message : err))
    }
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /**
   * Encrypt `blob` and fan it out to all current Sync Group members.
   * Throws {@link HushSyncError} if this device is not yet in a group.
   */
  async send(blob: Buffer): Promise<void> {
    try {
      this._session.send(blob)
    } catch (err) {
      throw new HushSyncError(String(err instanceof Error ? err.message : err))
    }
  }

  // ── Destroy ───────────────────────────────────────────────────────────────

  /**
   * Destroy the Sync Group — push a Revoke to all members and wipe local state.
   * All members receive a `groupDestroyed` event. Session is terminal after this.
   */
  destroyGroup(): void {
    try {
      this._session.destroyGroup()
    } catch (err) {
      throw new HushSyncError(String(err instanceof Error ? err.message : err))
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** `true` after {@link dispose} has been called. */
  get disposed(): boolean {
    return this._disposed
  }

  /**
   * Release client resources:
   * - removes all EventEmitter listeners so no callbacks fire on a
   *   destroyed window or stale context
   * - sets {@link disposed} to `true`
   *
   * The underlying relay connection is held by the Rust session and will be
   * closed when it is garbage-collected. TSFNs are already `unref()`'d so
   * they do not prevent process exit.
   *
   * Safe to call multiple times (idempotent).
   */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
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
    // on_message, on_removed_from_group, on_group_destroyed, on_connection_changed
    // are wired at construction time via the native.HushSession constructor.
  }
}
