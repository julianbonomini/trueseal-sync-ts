/**
 * SDK-2 (#10): the canonical taxonomy as RUNTIME lists, for the G5 vector
 * checks in __tests__/vectors.test.mjs.
 *
 * The public API exposes these vocabularies as TYPE unions (no runtime
 * representation), so the vector test cannot reference them through the
 * bindings without these constants. `satisfies` ties every entry to the
 * public union (a renamed or removed case fails `tsc`), and the
 * `Exclude<...> extends never` assertion makes each list EXHAUSTIVE (a new
 * public case that is missing here fails `tsc`). Together they are the TS
 * analog of the Swift/Kotlin precedents' compile-time case references —
 * the lists are exactly the canonical surface, nothing stringly-typed.
 *
 * These constants are deliberately NOT re-exported from the package
 * entrypoint: the canonical API surface is fixed by ADR-0028 and the G12
 * parity check compares it across the three SDKs. The test reaches them at
 * `dist/vector-vocabularies.js` — compiled by the same build that produces
 * the shipped entrypoint.
 *
 * TRUESEAL_ERROR_CODES already exists as a public runtime export (pinned
 * literal-for-literal in shared-facts.json order in typed-errors.test.mjs);
 * it is re-asserted here only for exhaustiveness against the type.
 */

import type {
  GroupStatus,
  StatusReason,
  ConnectionState,
  TrueSealEvent,
  AdmissionDropReason,
  UnreadableReason,
  SendFailedReason,
  DeliveryIssue,
  TrueSealErrorCode,
} from './index.js'
import { TRUESEAL_ERROR_CODES } from './index.js'

/** shared-facts.json `statuses`. */
export const GROUP_STATUSES = [
  'notJoined',
  'pendingJoin',
  'member',
  'leaving',
  'destroying',
] as const satisfies readonly GroupStatus[]

/** shared-facts.json `statusReasons`. */
export const STATUS_REASONS = [
  'created',
  'joined',
  'left',
  'removed',
  'destroyed',
  'storeReset',
] as const satisfies readonly StatusReason[]

/** shared-facts.json `connectionStates`. */
export const CONNECTION_STATES = [
  'connecting',
  'connected',
  'disconnected',
  'relayVersionUnsupported',
] as const satisfies readonly ConnectionState['state'][]

/** shared-facts.json `events`. */
export const EVENT_TYPES = [
  'statusChanged',
  'membersChanged',
  'joinRequest',
  'connectionChanged',
  'admissionDropped',
] as const satisfies readonly TrueSealEvent['type'][]

/** shared-facts.json `admissionDropReasons`. */
export const ADMISSION_DROP_REASONS = [
  'groupFull',
] as const satisfies readonly AdmissionDropReason[]

/** shared-facts.json `unreadableReasons` (ADR-0034 §3). */
export const UNREADABLE_REASONS = [
  'malformed',
  'senderOutdated',
  'expired',
  'droppedWhileHeld',
] as const satisfies readonly UnreadableReason[]

/** shared-facts.json `sendFailedReasons` (ADR-0034 §3). */
export const SEND_FAILED_REASONS = [
  'tooLarge',
  'malformed',
  'expired',
] as const satisfies readonly SendFailedReason[]

/** shared-facts.json `deliveryIssues`. */
export const DELIVERY_ISSUE_TYPES = [
  'unreadable',
  'unauthorized',
  'heldForUpgrade',
  'handlerGaveUp',
  'sendFailed',
] as const satisfies readonly DeliveryIssue['type'][]

// ── Compile-time exhaustiveness assertions ──────────────────────────────────
// Each `Exclude<union, list-member>` must reduce to `never`. If the public
// union gains a case these lists don't name, tsc fails on every matrix leg —
// the lists can never silently lag the canonical surface.

type AssertExact<Union, Members extends Union> =
  Exclude<Union, Members> extends never ? true : { missing: Exclude<Union, Members> }

const _groupStatuses: AssertExact<GroupStatus, (typeof GROUP_STATUSES)[number]> = true
const _statusReasons: AssertExact<StatusReason, (typeof STATUS_REASONS)[number]> = true
const _connectionStates: AssertExact<ConnectionState['state'], (typeof CONNECTION_STATES)[number]> = true
const _eventTypes: AssertExact<TrueSealEvent['type'], (typeof EVENT_TYPES)[number]> = true
const _admissionDropReasons: AssertExact<AdmissionDropReason, (typeof ADMISSION_DROP_REASONS)[number]> = true
const _unreadableReasons: AssertExact<UnreadableReason, (typeof UNREADABLE_REASONS)[number]> = true
const _sendFailedReasons: AssertExact<SendFailedReason, (typeof SEND_FAILED_REASONS)[number]> = true
const _deliveryIssueTypes: AssertExact<DeliveryIssue['type'], (typeof DELIVERY_ISSUE_TYPES)[number]> = true
const _errorCodes: AssertExact<TrueSealErrorCode, (typeof TRUESEAL_ERROR_CODES)[number]> = true

// Referenced so `tsc` keeps the assertions under noUnusedLocals-style linting
// in consumer configs; at runtime this module's value is its exports.
export const _exhaustivenessAssertions = [
  _groupStatuses,
  _statusReasons,
  _connectionStates,
  _eventTypes,
  _admissionDropReasons,
  _unreadableReasons,
  _sendFailedReasons,
  _deliveryIssueTypes,
  _errorCodes,
] as const
