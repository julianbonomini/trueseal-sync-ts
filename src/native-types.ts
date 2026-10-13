// Internal type declarations for the raw NAPI bindings.
// Never re-exported — callers only see the clean TrueSeal API (src/index.ts).

export interface NativeMember {
  id: string
  name: string
}

/** The `connection` getter's raw shape: state plus min/max on relayVersionUnsupported. */
export interface NativeConnectionInfo {
  state: string
  min?: number
  max?: number
}

/** The parsed typed Relay Address (the return of native parseRelayAddress). */
export interface NativeParsedAddress {
  host: string
  publicKey: Buffer
  receivePort: number
  pushPort: number
}

/** The version triple (ADR-0022 Reporting). */
export interface NativeInfo {
  sdkVersion: string
  transportVersion: number
  endToEndVersion: number
}

/**
 * Internal wrapper around the core's canonical TrueSeal object.
 *
 * Fallible methods throw JS Error objects with a canonical `code` property
 * (one of the 14 TrueSealError codes) and typed extras where the case
 * carries them (`status`, `max`, `found`, `supported`) — see session.rs.
 */
export declare class CoreSession {
  /**
   * @param relayAddress    the Relay Address string
   * @param baseDir         directory for the SQLite database
   * @param namespace       scopes the DB file; one session per namespace
   * @param maxPayloadBytes optional creation-time payload-limit override
   * @param onEvent         `(eventJson: string) => void` — MUST NOT throw
   * @param onDeliveryIssue `(issueJson: string) => void` — MUST NOT throw
   */
  constructor(
    relayAddress: string,
    baseDir: string,
    namespace: string | null,
    maxPayloadBytes: number | null,
    onEvent: (eventJson: string) => void,
    onDeliveryIssue: (issueJson: string) => void,
  )

  // State getters
  status(): string
  me(): NativeMember
  connection(): NativeConnectionInfo

  // Receiving — one-shot, core-enforced; registering starts receiving.
  onMessage(
    callback: (id: string, fromId: string, fromName: string, body: Buffer, ackId: number) => void,
  ): void
  completeMessage(ackId: number, error: string | null): void
  cancelMessageHandler(): void

  // Sending
  /** Returns the stable Message ID once the message is durably queued. */
  send(blob: Buffer): string

  // Pairing, admitting side
  startPairing(): string
  accept(requestId: string): void
  cancelPairing(): void

  // Pairing, joining side
  join(token: string): void
  cancelJoin(): void

  // Membership
  members(): NativeMember[]
  remove(memberId: string): void
  leave(): void

  // Destroy
  destroyGroup(): void

  // Lifecycle — stops the connection and handlers; keeps Session State. Idempotent.
  close(): void
}

export declare function parseRelayAddress(input: string): NativeParsedAddress
export declare function truesealInfo(): NativeInfo
export declare function truesealMaxPayloadBytes(): number
export declare function truesealMaxGroupSize(): number
