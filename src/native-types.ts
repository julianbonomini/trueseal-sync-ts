// Internal type declarations for the raw NAPI bindings.
// Never re-exported — callers only see the clean TruesealSyncClient API.

export interface NativeMember {
  id: string
  name: string
}

/**
 * Internal wrapper around the core's canonical TrueSeal object.
 *
 * Fallible methods throw JS Error objects with a canonical `code` property
 * (one of the 14 TrueSealError codes) and typed extras where the case
 * carries them (`status`, `max`, `found`, `supported`) — see session.rs.
 */
export declare class CoreSession {
  constructor(
    baseDir: string,
    namespace: string,
    relayHost: string,
    relayPub: Buffer,
    onMessage: (blob: Buffer, senderId: string, messageId: string) => void,
    onRemovedFromGroup: () => void,
    onGroupDestroyed: () => void,
    onConnectionChanged: ((connected: boolean) => void) | null,
  )

  pairingToken(): string
  joinGroup(token: string): void
  setOnMemberRequest(callback: (requestId: string, name: string) => void): void
  acceptMember(requestId: string): void
  setOnMemberJoined(callback: (memberId: string, memberName: string) => void): void
  setOnMemberLeft(callback: (memberId: string, memberName: string) => void): void
  cancelPairing(): void
  localNodeId(): string
  localDeviceName(): string
  members(): NativeMember[]
  removeMember(memberId: string): void
  /** Returns the stable Message ID once the message is durably queued. */
  send(blob: Buffer): string
  destroyGroup(): void
  /** Stop the connection and handlers; keep Session State. Idempotent. */
  close(): void
}
