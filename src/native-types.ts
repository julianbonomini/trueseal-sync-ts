// Internal type declarations for the raw NAPI bindings.
// Never re-exported — callers only see the clean HushSyncClient API.

export interface NativeMember {
  id: string
  name: string
}

export declare class HushSession {
  constructor(
    baseDir: string,
    namespace: string,
    relayHost: string,
    relayPub: Buffer,
    onMessage: (blob: Buffer, senderNoisePub: string) => void,
    onRemovedFromGroup: () => void,
    onGroupDestroyed: () => void,
    onConnectionChanged: ((connected: boolean) => void) | null,
  )

  pairingToken(): string
  joinGroup(token: string): void
  setOnMemberRequest(callback: (token: string, name: string) => void): void
  acceptMember(token: string): boolean
  setOnMemberJoined(callback: (memberId: string, memberName: string) => void): void
  setOnMemberLeft(callback: (memberId: string, memberName: string) => void): void
  cancelPairing(): void
  localNodeId(): string
  localDeviceName(): string
  members(): NativeMember[]
  removeMember(memberId: string): void
  send(blob: Buffer): void
  destroyGroup(): void
}
