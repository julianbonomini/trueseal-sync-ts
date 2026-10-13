import { homedir } from 'node:os'
import { join } from 'node:path'

// Raw NAPI bindings — never re-exported.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const native = require('../index.js') as typeof import('./native-types.js')

// ── Public types ──────────────────────────────────────────────────────────────

/** A group member (the local device for {@link TrueSeal.me}, remote devices for {@link TrueSeal.members}). */
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
 * Why an asynchronous status transition happened (ADR-0028's statusChanged
 * mapping, amended by ADR-0032). Canonical codes from shared-facts.json
 * (`statusReasons`).
 */
export type StatusReason =
  | 'created'
  | 'joined'
  | 'left'
  | 'removed'
  | 'destroyed'
  | 'storeReset'

/**
 * The relay connection state (ADR-0028). A discriminated union so the
 * `relayVersionUnsupported` case can carry the relay's supported range.
 * Canonical codes from shared-facts.json (`connectionStates`).
 */
export type ConnectionState =
  | { readonly state: 'connecting' }
  | { readonly state: 'connected' }
  | { readonly state: 'disconnected' }
  | { readonly state: 'relayVersionUnsupported'; readonly min: number; readonly max: number }

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

/** A delivered `Sync` message (ADR-0026, ADR-0031). */
export interface TrueSealMessage {
  /**
   * Stable, opaque, derived from the author's signing key and the Envelope
   * Sequence. The same across relay re-delivery; a handler sees it twice
   * only after a crash mid-handling (at-least-once, ADR-0026 — persist it
   * with app state to dedupe across restarts).
   */
  id: string
  /** The sending member. `from.id` is the same identifier as in {@link TrueSeal.members}. */
  from: Member
  /** The raw application payload. */
  body: Buffer
}

/** The admitter's view of a Pair that proved knowledge of the Pairing Secret (ADR-0023). */
export interface JoinRequest {
  /** Opaque request identifier — pass it back to {@link TrueSeal.accept} to admit the device. */
  id: string
  /** The joiner's device name. A name is never authentication (ADR-0023). */
  name: string
}

/** Why an admission was dropped during membership convergence (ADR-0027). */
export type AdmissionDropReason = 'groupFull'

/**
 * The single event sum type (ADR-0028, as amended by ADR-0032), delivered
 * to every registered `onEvent` listener. A discriminated union on `type`;
 * the case names are canonical (shared-facts.json `events`).
 *
 * `statusChanged` fires only for ASYNCHRONOUS transitions — the ones the
 * caller cannot observe from its own call (SYNC-15's ADR-0028 amendment):
 * `member/created`, `member/joined`, and `notJoined/left|removed|destroyed|storeReset`.
 * Synchronous transitions (`join` → `pendingJoin`, `leave` → `leaving`,
 * `destroyGroup` → `destroying`) raise no event: learn them from the call's
 * success and the {@link TrueSeal.status} getter.
 */
export type TrueSealEvent =
  | { readonly type: 'statusChanged'; readonly status: GroupStatus; readonly reason: StatusReason }
  | { readonly type: 'membersChanged'; readonly members: readonly Member[] }
  | { readonly type: 'joinRequest'; readonly request: JoinRequest }
  | { readonly type: 'connectionChanged'; readonly connection: ConnectionState }
  | { readonly type: 'admissionDropped'; readonly name: string; readonly reason: AdmissionDropReason }

/** Why an incoming Blob was rejected as unreadable (ADR-0034 §3). */
export type UnreadableReason =
  | 'malformed'
  | 'senderOutdated'
  | 'expired'
  | 'droppedWhileHeld'

/** Why the library gave up sending an outgoing message (ADR-0034 §3). Every reason is permanent. */
export type SendFailedReason = 'tooLarge' | 'malformed' | 'expired'

/**
 * A typed, device-local report that the library could not deliver or handle
 * a message (ADR-0026/0034). Never sent to the other device or the relay.
 * Observing issues is optional; the library already does the right thing.
 * There is deliberately no `undeliverableAfterUpgrade` case (withdrawn by
 * ADR-0034 — an upgrade re-seals the outbox instead). A discriminated union
 * on `type`; the case names are canonical (shared-facts.json `deliveryIssues`).
 */
export type DeliveryIssue =
  | { readonly type: 'unreadable'; readonly reason: UnreadableReason }
  | { readonly type: 'unauthorized' }
  | { readonly type: 'heldForUpgrade'; readonly version: number }
  | { readonly type: 'handlerGaveUp'; readonly messageId: string; readonly error: string }
  | { readonly type: 'sendFailed'; readonly messageId: string; readonly reason: SendFailedReason }

/** The version triple reported by every TrueSeal SDK (ADR-0022 Reporting, ADR-0030). */
export interface TrueSealInfo {
  sdkVersion: string
  transportVersion: number
  endToEndVersion: number
}

/**
 * Options for {@link TrueSeal.open}.
 */
export interface TrueSealOptions {
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
  /**
   * Creation-time payload-limit override (ADR-0025): can only LOWER the
   * Protocol Size Limit (e.g. to match a stricter relay). A property of how
   * the app deploys, not something to mutate mid-flight.
   */
  maxPayloadBytes?: number
}

/**
 * The typed form of a Relay Address (ADR-0028). {@link TrueSeal.open}
 * accepts either this or the string form; the port is never dropped
 * silently — the string always carries the ports explicitly.
 */
export class RelayAddress {
  /** Relay hostname or IP (IPv6 unbracketed here; {@link toString} brackets it). */
  readonly host: string
  /** The relay's 32-byte X25519 public key. */
  readonly publicKey: Buffer
  readonly receivePort: number
  readonly pushPort: number

  constructor(host: string, publicKey: Buffer, receivePort = 7700, pushPort = 7701) {
    this.host = host
    this.publicKey = publicKey
    this.receivePort = receivePort
    this.pushPort = pushPort
  }

  /**
   * The canonical string form: `trueseal://<key hex>@host:receivePort?push=pushPort`.
   * Ports are always explicit, matching what the relay's `address` command prints.
   */
  toString(): string {
    const host = this.host.includes(':') && !this.host.startsWith('[') ? `[${this.host}]` : this.host
    return `trueseal://${this.publicKey.toString('hex')}@${host}:${this.receivePort}?push=${this.pushPort}`
  }
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

/**
 * A cancel handle returned by every `on…` registration. Cancelling
 * an event or issue subscription stops delivery to that listener. Cancelling
 * the message-handler subscription drops the handler — but registration is
 * one-shot per object: a dropped handler CANNOT be re-registered (SYNC-15),
 * and a second {@link TrueSeal.onMessage} still fails with
 * `messageHandlerAlreadySet`.
 *
 * Shape note: ADR-0028 names an unsubscribe FUNCTION for TS; this
 * `Subscription` class with `cancel()` deliberately converges with the
 * Swift and Kotlin references instead, so the three SDKs share one shape
 * and the G12 parity check compares like with like.
 */
export class Subscription {
  private _cancel: (() => void) | null

  /** @internal */
  constructor(cancel: () => void) {
    this._cancel = cancel
  }

  /** Idempotent. */
  cancel(): void {
    const cancel = this._cancel
    this._cancel = null
    cancel?.()
  }
}

// ── Error plumbing ────────────────────────────────────────────────────────────

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

// ── Buffered listener fan-out ─────────────────────────────────────────────────

/**
 * Fan-out for the event and issue streams (ADR-0028): any number of
 * listeners; items raised before the FIRST listener registers are buffered
 * and flushed to it; later listeners get live items only. A throwing
 * listener never reaches the native callback (a throw into a
 * ThreadsafeFunction with ErrorStrategy::Fatal would abort the process):
 * the error is re-thrown on the next event-loop tick so it surfaces as an
 * uncaught exception — stack trace + exit code 1 — rather than SIGABRT.
 */
class ListenerFanOut<T> {
  private listeners: Array<(item: T) => void> = []
  private buffer: T[] | null = []

  /** The native dispatcher entry point. MUST NOT throw. */
  dispatch = (item: T): void => {
    if (this.buffer !== null) {
      this.buffer.push(item)
      return
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(item)
      } catch (err) {
        process.nextTick(() => {
          throw err
        })
      }
    }
  }

  add(listener: (item: T) => void): Subscription {
    this.listeners.push(listener)
    if (this.buffer !== null) {
      // First listener: flush the backlog to it, then go live.
      const backlog = this.buffer
      this.buffer = null
      for (const item of backlog) {
        try {
          listener(item)
        } catch (err) {
          process.nextTick(() => {
            throw err
          })
        }
      }
    }
    return new Subscription(() => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    })
  }
}

// ── TrueSeal ──────────────────────────────────────────────────────────────────

/**
 * E2EE, local-first sync for Node.js and Electron — the canonical TrueSeal
 * API (sync ADR-0028), one object per device.
 *
 * The object outlives group membership: after removal, leave or Destroy
 * Group the library wipes the namespace, rotates to a fresh identity and
 * the same object reaches `notJoined` and can pair again (the ADR-0028
 * lifecycle rule).
 *
 * @example
 * ```ts
 * const ts = await TrueSeal.open('trueseal://<relay public key hex>@relay.example.com')
 *
 * ts.onEvent((event) => {
 *   if (event.type === 'joinRequest') ts.accept(event.request.id)
 * })
 * ts.onMessage((message) => {
 *   console.log('received', message.id, message.body)
 * })
 * const messageId = ts.send(Buffer.from('hello'))
 * ```
 */
export class TrueSeal {
  private readonly _session: InstanceType<typeof native.CoreSession>
  private readonly _events: ListenerFanOut<TrueSealEvent>
  private readonly _issues: ListenerFanOut<DeliveryIssue>

  private constructor(
    session: InstanceType<typeof native.CoreSession>,
    events: ListenerFanOut<TrueSealEvent>,
    issues: ListenerFanOut<DeliveryIssue>,
  ) {
    this._session = session
    this._events = events
    this._issues = issues
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  /**
   * Open a TrueSeal object. The relay connects in the background — this
   * resolves before the connection is up and never rejects because the
   * relay is unreachable. `send()` works immediately (messages queue in the
   * outbox).
   *
   * @param relay the Relay Address string
   *   (`trueseal://<relay public key hex>@host[:receivePort][?push=pushPort]`)
   *   or the typed {@link RelayAddress} form.
   *
   * Throws typed {@link TrueSealError} (`invalidRelayAddress`,
   * `invalidNamespace`, `storage`, `storeTooNew`) for configuration and
   * store failures.
   */
  static async open(relay: string | RelayAddress, options: TrueSealOptions = {}): Promise<TrueSeal> {
    const {
      storageDir = join(homedir(), '.trueseal-sync'),
      namespace = 'default',
      maxPayloadBytes = null,
    } = options
    const relayAddress = typeof relay === 'string' ? relay : relay.toString()

    // The fan-outs exist BEFORE the native session so the dispatcher
    // closures can capture them; the native constructor wires the core's
    // event and issue streams to them immediately. The dispatchers are
    // infallible by construction (ListenerFanOut.dispatch never throws):
    // a throw into the native callback would abort the process.
    const events = new ListenerFanOut<TrueSealEvent>()
    const issues = new ListenerFanOut<DeliveryIssue>()
    const dispatchSafely = (dispatch: (json: string) => void) => (json: string) => {
      try {
        dispatch(json)
      } catch (err) {
        process.nextTick(() => {
          throw err
        })
      }
    }

    let session: InstanceType<typeof native.CoreSession>
    try {
      session = new native.CoreSession(
        relayAddress,
        storageDir,
        namespace,
        maxPayloadBytes,
        dispatchSafely((json) => events.dispatch(JSON.parse(json) as TrueSealEvent)),
        dispatchSafely((json) => issues.dispatch(JSON.parse(json) as DeliveryIssue)),
      )
    } catch (err) {
      rethrowTyped(err)
    }
    return new TrueSeal(session, events, issues)
  }

  /**
   * Stop the connection and the handlers; keep Session State (ADR-0028).
   * Idempotent. After `close()`, every call fails with typed `closed`.
   * The same store can be re-opened with a new `TrueSeal.open`.
   */
  close(): void {
    this._session.close()
  }

  /** Alias for {@link close} — supports the TC39 `using` keyword. */
  [Symbol.dispose](): void {
    this.close()
  }

  // ── State ─────────────────────────────────────────────────────────────────

  /** The group status (ADR-0028). Fresh from the core on every read. */
  get status(): GroupStatus {
    try {
      return this._session.status() as GroupStatus
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /** This device's member record (`{id, name}`). Fresh from the core on every read. */
  get me(): Member {
    try {
      return this._session.me()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /** The current remote group members (excludes this device). Fresh from the core on every read. */
  get members(): Member[] {
    try {
      return this._session.members()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /** The relay connection state (ADR-0028). Fresh from the core on every read. */
  get connection(): ConnectionState {
    try {
      const info = this._session.connection()
      if (info.state === 'relayVersionUnsupported') {
        // Fail loudly on a glue bug rather than fabricate a version range.
        if (typeof info.min !== 'number' || typeof info.max !== 'number') {
          throw new Error(
            `native glue returned relayVersionUnsupported without min/max ` +
              `(got min=${String(info.min)}, max=${String(info.max)}) — a glue bug, not a relay condition`,
          )
        }
        return { state: 'relayVersionUnsupported', min: info.min, max: info.max }
      }
      return { state: info.state as 'connecting' | 'connected' | 'disconnected' }
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Receiving ─────────────────────────────────────────────────────────────

  /**
   * Register THE message handler (ADR-0026/0028). Registering starts
   * receiving. Registration is one-shot per object — a second call fails
   * with typed `messageHandlerAlreadySet`, and cancelling the returned
   * {@link Subscription} does not re-enable registration (SYNC-15).
   *
   * The handler may be async: the core AWAITS it — the relay is acked only
   * after the returned promise settles. A throw or rejection marks the
   * attempt failed: the library retries 5 times with backoff, then acks,
   * drops and reports `handlerGaveUp` on {@link onDeliveryIssue}.
   *
   * Return promptly: a handler parked for >75s wedges delivery for every
   * message behind it and the client declares the session dead (the
   * liveness rule); long work belongs in a queue the handler feeds.
   */
  onMessage(handler: (message: TrueSealMessage) => void | Promise<void>): Subscription {
    // One-shot is enforced by the CORE (its check_open() runs first, so a
    // call after close() correctly fails with `closed`, and a second
    // registration — even after cancelMessageHandler — with
    // `messageHandlerAlreadySet`). No TS-side latch: the core's ordering
    // IS the canonical behavior.
    try {
      this._session.onMessage(
        (id: string, fromId: string, fromName: string, body: Buffer, ackId: number) => {
          // Infallible dispatcher: the native side awaits completeMessage.
          const complete = (error: string | null) => {
            try {
              this._session.completeMessage(ackId, error)
            } catch {
              // The session is closing; the core is already tearing down.
            }
          }
          let result: void | Promise<void>
          try {
            result = handler({ id, from: { id: fromId, name: fromName }, body })
          } catch (err) {
            complete(err instanceof Error ? err.message : String(err))
            return
          }
          const value: unknown = result
          // Thenable check (not instanceof Promise: cross-realm promises
          // fail instanceof — Electron is a stated target). The probe AND
          // the subscription sit inside the try/catch: a throwing `then`
          // getter must reach complete(err), never escape into the TSFN
          // callback (ErrorStrategy::Fatal → SIGABRT). Functions are
          // probed too — a function-valued thenable must not be mistaken
          // for a synchronous return (that would ack before the work).
          try {
            const then =
              (typeof value === 'object' && value !== null) || typeof value === 'function'
                ? (value as { then?: unknown }).then
                : undefined
            if (typeof then === 'function') {
              then.call(
                value,
                () => complete(null),
                (err: unknown) => complete(err instanceof Error ? err.message : String(err)),
              )
            } else {
              complete(null)
            }
          } catch (err) {
            complete(err instanceof Error ? err.message : String(err))
          }
        },
      )
    } catch (err) {
      rethrowTyped(err)
    }
    return new Subscription(() => this._session.cancelMessageHandler())
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * Queue `body` for fan-out to all current group members (ADR-0026).
   * Returns the stable Message ID once the message is durably in the
   * outbox — `send()` returning means durably queued, never that the relay
   * has accepted it yet.
   *
   * Throws typed {@link TrueSealError}: `payloadTooLarge` (carries `max`)
   * if the body exceeds the Protocol Size Limit, `notMember` (carries
   * `status`) if this device is not currently a member.
   */
  send(body: Buffer): string {
    try {
      return this._session.send(body)
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Events and delivery issues ────────────────────────────────────────────

  /**
   * Register an event listener (ADR-0028). Any number of listeners; events
   * raised before the FIRST listener registers are buffered and flushed to
   * it. Returns a {@link Subscription} whose `cancel()` stops delivery to
   * this listener.
   */
  onEvent(listener: (event: TrueSealEvent) => void): Subscription {
    return this._events.add(listener)
  }

  /**
   * Register a delivery-issue listener (ADR-0026/0034). Optional — the
   * library already does the right thing; this stream exists for surfacing
   * delivery problems to the user. Same buffering and cancellation
   * semantics as {@link onEvent}.
   */
  onDeliveryIssue(listener: (issue: DeliveryIssue) => void): Subscription {
    return this._issues.add(listener)
  }

  // ── Pairing, admitting side ───────────────────────────────────────────────

  /**
   * Open a Pairing Window and return the Pairing Token (ADR-0023). Show it
   * to the peer (QR code, AirDrop, ...) and pass it to their
   * {@link TrueSeal.join}. Requests arrive as `joinRequest` events;
   * there is no expiry timer — the window stays open until
   * {@link cancelPairing} or an admission.
   */
  startPairing(): string {
    try {
      return this._session.startPairing()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /**
   * Admit a pending device by the opaque `requestId` from a `joinRequest`
   * event. Either succeeds or throws typed {@link TrueSealError}
   * (`pairingClosed` when the window is closed or the request id is
   * unknown — an unaccepted request disappears when the window closes;
   * `groupFull{max}` at the Maximum Group Size). There is no reject: the
   * protocol sends no decline (ADR-0023).
   */
  accept(requestId: string): void {
    try {
      this._session.accept(requestId)
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /** Close the Pairing Window without admitting any device. */
  cancelPairing(): void {
    try {
      this._session.cancelPairing()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Pairing, joining side ─────────────────────────────────────────────────

  /**
   * Join a group as the responding device using the initiator's Pairing
   * Token. Moves the device to `pendingJoin` (learn it from this call's
   * success and the {@link status} getter — no event for synchronous
   * transitions). Throws typed {@link TrueSealError} (`alreadyInGroup`,
   * `invalidPairingToken`).
   */
  join(token: string): void {
    try {
      this._session.join(token)
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /** Abandon a Pending Join; the device returns to `notJoined` (ADR-0023). */
  cancelJoin(): void {
    try {
      this._session.cancelJoin()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Membership ────────────────────────────────────────────────────────────

  /**
   * Remove a group member by their `id` from {@link members} (ADR-0027).
   * The removed device's library wipes its namespace and rotates to a
   * fresh identity automatically. Throws typed `memberNotFound` for an
   * unknown id, `notMember{status}` when this device is not a member.
   */
  remove(memberId: string): void {
    try {
      this._session.remove(memberId)
    } catch (err) {
      rethrowTyped(err)
    }
  }

  /**
   * Leave the group (ADR-0027): the device moves to `leaving` (learn it
   * from this call's success — no event), and to `notJoined` with reason
   * `left` once the relay has accepted the Leave.
   */
  leave(): void {
    try {
      this._session.leave()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Destroy ───────────────────────────────────────────────────────────────

  /**
   * Destroy the group (ADR-0029): queue a durable, forwarded Revoke to all
   * members. The device moves to `destroying` (no event — synchronous);
   * the wipe fires and `statusChanged(notJoined, destroyed)` raises when
   * the relay has accepted every Revoke. All members receive it; a Revoke
   * from any past or present member is honoured.
   */
  destroyGroup(): void {
    try {
      this._session.destroyGroup()
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Statics ───────────────────────────────────────────────────────────────

  /** The version triple for this build (ADR-0022 Reporting), from the core constants. */
  static get info(): TrueSealInfo {
    return native.truesealInfo()
  }

  /** The Protocol Size Limit (61,440 bytes, ADR-0025), from the core constant. */
  static get maxPayloadBytes(): number {
    return native.truesealMaxPayloadBytes()
  }

  /** The Maximum Group Size (32, ADR-0027), from the core constant. */
  static get maxGroupSize(): number {
    return native.truesealMaxGroupSize()
  }

  /**
   * Parse a Relay Address string into the typed form (ADR-0028). Strict:
   * the scheme is mandatory, the key is exactly 64 hex chars (uppercase
   * accepted), the host never contains `@`, IPv6 hosts are bracketed, and
   * `push=` is the only query parameter. Throws typed
   * {@link TrueSealError} (`invalidRelayAddress`).
   */
  static parseRelayAddress(input: string): RelayAddress {
    try {
      const parsed = native.parseRelayAddress(input)
      return new RelayAddress(parsed.host, parsed.publicKey, parsed.receivePort, parsed.pushPort)
    } catch (err) {
      rethrowTyped(err)
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────
}

/**
 * Test-only export (underscore prefix): the buffered listener fan-out, so
 * its buffering, cancellation and throw-containment semantics can be
 * unit-tested without a relay. Not part of the public API.
 */
export { ListenerFanOut as _ListenerFanOut }
