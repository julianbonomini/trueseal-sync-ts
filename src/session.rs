// NAPI-RS glue wrapping the canonical core FFI: trueseal_sync::ffi::TrueSeal.
//
// SDK-1 (#9): the binding exposes the canonical TrueSeal shape one-to-one —
// the SDK adds syntax, not behaviour (ADR-0028).
//
// Errors: every fallible native call maps the core's typed 14-variant
// `TrueSealError` to a thrown JS Error carrying `code` (canonical camelCase,
// character-for-character from trueseal-sync docs/shared-facts.json — the
// G12 parity source) plus typed extras as real own properties where the
// case carries them (`status`, `max`, `found`, `supported`). The mapping is
// an exhaustive Rust `match` with NO wildcard arm: if the core ever grows a
// 15th error variant, THIS CRATE FAILS TO COMPILE. That is the
// exhaustiveness guard — there is no stringly-typed fallback anywhere.
//
// Events and delivery issues: the core's single streams are bridged to JS
// as JSON strings (small payloads; building nested JS objects from a
// background thread is needlessly fragile). The TS layer parses, buffers
// until the first listener, and fans out. The JSON field names ARE the
// public TS event shapes — keep them canonical.
//
// The message handler (ADR-0026/0028): one-shot, registered by the
// `onMessage` METHOD so the CORE enforces `messageHandlerAlreadySet`
// (exactly like Swift and Kotlin). It is awaited: the DeliverAck leaves the
// device only after the JS handler settles. napi-rs 2 ThreadsafeFunction
// does not await a returned Promise, so the bridge passes an ack id with
// every delivery and the TS layer calls `completeMessage(ackId, error?)`
// when the handler's promise settles; the Rust side awaits a oneshot keyed
// by that id. A JS throw or rejection maps to `HandlerError::Failed` — the
// core's 5-attempt policy, then `handlerGaveUp`.
//
// All callbacks that fire from background threads use ThreadsafeFunction,
// and every TSFN is `unref()`-ed so it does not keep the Node.js process
// alive. TSFN callbacks must NEVER throw into napi (ErrorStrategy::Fatal
// would abort the process): the TS dispatchers are infallible by
// construction.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

// napi 3 (TS-1, #14): the ErrorStrategy generic became the `CalleeHandled`
// const generic. Our dispatchers are infallible by construction and must
// never throw into napi, so every TSFN is callee-handled = false (the old
// ErrorStrategy::Fatal semantics): a JS throw aborts rather than being
// swallowed. CallJsBackArgs (Args) is plain Rust values — napi 3 converts
// them to JS values at call time via JsValuesTupleIntoVec.
type FatalTsfn<T, Args> = ThreadsafeFunction<T, Unknown<'static>, Args, Status, false>;

/// The JS dispatcher's argument tuple for a message delivery:
/// `(id, fromId, fromName, body, ackId)`.
type DeliveryArgs = FnArgs<(String, String, String, Buffer, f64)>;
use tokio::sync::oneshot;

use trueseal_sync::ffi::{
    AdmissionDropReason, ConnectionState, DeliveryIssue, GroupStatus, HandlerError,
    SendFailedReason, StatusReason, Subscription, TrueSeal, TrueSealError as CoreError,
    TrueSealEvent, TrueSealEventListener, TrueSealIssueListener, TrueSealMessage,
    TrueSealMessageHandler, UnreadableReason,
};
use trueseal_sync::relay_address::RelayAddress as CoreRelayAddress;

// ── Typed error mapping ───────────────────────────────────────────────────────

/// Canonical GroupStatus codes (shared-facts.json `statuses`), camelCase.
fn group_status_code(status: GroupStatus) -> &'static str {
    match status {
        GroupStatus::NotJoined => "notJoined",
        GroupStatus::PendingJoin => "pendingJoin",
        GroupStatus::Member => "member",
        GroupStatus::Leaving => "leaving",
        GroupStatus::Destroying => "destroying",
    }
}

/// Map the core's typed error to a thrown JS Error with `code` + typed extras.
///
/// The match is exhaustive with no wildcard: a new core variant is a compile
/// error here, never a silent fallback.
fn typed_err(env: &Env, e: CoreError) -> napi::Error {
    let code: &'static str = match &e {
        CoreError::InvalidRelayAddress { .. } => "invalidRelayAddress",
        CoreError::InvalidNamespace { .. } => "invalidNamespace",
        CoreError::Storage { .. } => "storage",
        CoreError::Closed => "closed",
        CoreError::NotMember { .. } => "notMember",
        CoreError::AlreadyInGroup => "alreadyInGroup",
        CoreError::InvalidPairingToken => "invalidPairingToken",
        CoreError::PairingClosed => "pairingClosed",
        CoreError::GroupFull { .. } => "groupFull",
        CoreError::MemberNotFound => "memberNotFound",
        CoreError::PayloadTooLarge { .. } => "payloadTooLarge",
        CoreError::MessageHandlerAlreadySet => "messageHandlerAlreadySet",
        CoreError::StoreTooNew { .. } => "storeTooNew",
        CoreError::ManifestVersionExhausted => "manifestVersionExhausted",
    };

    // napi 3 (TS-1): create_error returns the lifetimed Object<'_>, so the
    // old build-closure pattern (which had to NAME the return type) becomes
    // a straight-line match. The fallback semantics are unchanged: if the VM
    // is already too unhappy to build the propertied object, return the
    // plain error instead.
    let mut obj = match env.create_error(napi::Error::from_reason(e.to_string())) {
        Ok(obj) => obj,
        Err(err) => return err,
    };
    let build = (|| -> napi::Result<()> {
        obj.set_named_property("code", env.create_string(code)?)?;
        match &e {
            CoreError::NotMember { status } => {
                obj.set_named_property("status", env.create_string(group_status_code(*status))?)?;
            }
            CoreError::GroupFull { max } | CoreError::PayloadTooLarge { max } => {
                obj.set_named_property("max", env.create_uint32(*max)?)?;
            }
            CoreError::StoreTooNew { found, supported } => {
                obj.set_named_property("found", env.create_uint32(*found)?)?;
                obj.set_named_property("supported", env.create_uint32(*supported)?)?;
            }
            _ => {}
        }
        Ok(())
    })();

    match build {
        Ok(()) => {
            // Throw the propertied object ourselves; the returned
            // PendingException tells napi-rs to leave it alone.
            unsafe { napi::sys::napi_throw(env.raw(), obj.raw()) };
            napi::Error::new(napi::Status::PendingException, "")
        }
        // The VM is already unhappy if setting properties fails; fall back
        // to the plain error (never reached in practice).
        Err(err) => err,
    }
}

// ── Canonical code helpers (event/issue JSON) ─────────────────────────────────

fn status_reason_code(reason: StatusReason) -> &'static str {
    match reason {
        StatusReason::Created => "created",
        StatusReason::Joined => "joined",
        StatusReason::Left => "left",
        StatusReason::Removed => "removed",
        StatusReason::Destroyed => "destroyed",
        StatusReason::StoreReset => "storeReset",
    }
}

fn connection_json(connection: &ConnectionState) -> serde_json::Value {
    match connection {
        ConnectionState::Connecting => serde_json::json!({ "state": "connecting" }),
        ConnectionState::Connected => serde_json::json!({ "state": "connected" }),
        ConnectionState::Disconnected => serde_json::json!({ "state": "disconnected" }),
        ConnectionState::RelayVersionUnsupported { min, max } => serde_json::json!({
            "state": "relayVersionUnsupported",
            "min": min,
            "max": max,
        }),
    }
}

/// Serialize a canonical event to the JSON shape the TS layer parses.
/// The field names ARE the public TS event union — keep them canonical.
fn event_json(event: &TrueSealEvent) -> String {
    let value = match event {
        TrueSealEvent::StatusChanged { status, reason } => serde_json::json!({
            "type": "statusChanged",
            "status": group_status_code(*status),
            "reason": status_reason_code(*reason),
        }),
        TrueSealEvent::MembersChanged { members } => serde_json::json!({
            "type": "membersChanged",
            "members": members
                .iter()
                .map(|m| serde_json::json!({ "id": m.id, "name": m.name }))
                .collect::<Vec<_>>(),
        }),
        TrueSealEvent::JoinRequest { request } => serde_json::json!({
            "type": "joinRequest",
            "request": { "id": request.id, "name": request.name },
        }),
        TrueSealEvent::ConnectionChanged { connection } => serde_json::json!({
            "type": "connectionChanged",
            "connection": connection_json(connection),
        }),
        TrueSealEvent::AdmissionDropped { name, reason } => serde_json::json!({
            "type": "admissionDropped",
            "name": name,
            "reason": match reason {
                AdmissionDropReason::GroupFull => "groupFull",
            },
        }),
    };
    value.to_string()
}

/// Serialize a canonical delivery issue to the JSON shape the TS layer parses.
fn issue_json(issue: &DeliveryIssue) -> String {
    let value = match issue {
        DeliveryIssue::Unreadable { reason } => serde_json::json!({
            "type": "unreadable",
            "reason": match reason {
                UnreadableReason::Malformed => "malformed",
                UnreadableReason::SenderOutdated => "senderOutdated",
                UnreadableReason::Expired => "expired",
                UnreadableReason::DroppedWhileHeld => "droppedWhileHeld",
            },
        }),
        DeliveryIssue::Unauthorized => serde_json::json!({ "type": "unauthorized" }),
        DeliveryIssue::HeldForUpgrade { version } => serde_json::json!({
            "type": "heldForUpgrade",
            "version": version,
        }),
        DeliveryIssue::HandlerGaveUp { message_id, error } => serde_json::json!({
            "type": "handlerGaveUp",
            "messageId": message_id,
            "error": error,
        }),
        DeliveryIssue::SendFailed { message_id, reason } => serde_json::json!({
            "type": "sendFailed",
            "messageId": message_id,
            "reason": match reason {
                SendFailedReason::TooLarge => "tooLarge",
                SendFailedReason::Malformed => "malformed",
                SendFailedReason::Expired => "expired",
            },
        }),
    };
    value.to_string()
}

// ── Member record ─────────────────────────────────────────────────────────────

/// A group member (the local device for `me()`, remote devices for `members()`).
#[napi(object)]
pub struct Member {
    /// Stable opaque identifier derived from the member's signing public key.
    pub id: String,
    /// Auto-generated human-readable name, e.g. "AmberFalcon".
    pub name: String,
}

/// The connection state for the `connection` getter: a plain state string,
/// plus `min`/`max` when the state is `relayVersionUnsupported`.
#[napi(object)]
pub struct ConnectionInfo {
    /// `connecting | connected | disconnected | relayVersionUnsupported`.
    pub state: String,
    pub min: Option<u32>,
    pub max: Option<u32>,
}

/// The parsed typed Relay Address (the return of `parseRelayAddress`).
#[napi(object)]
pub struct ParsedAddress {
    pub host: String,
    /// The relay's 32-byte X25519 public key.
    pub public_key: Buffer,
    pub receive_port: u32,
    pub push_port: u32,
}

/// The version triple (ADR-0022 Reporting).
#[napi(object)]
pub struct Info {
    pub sdk_version: String,
    pub transport_version: u32,
    pub end_to_end_version: u32,
}

// ── Callback bridges ──────────────────────────────────────────────────────────

/// Delivery handed to JS: the canonical Message fields plus the ack id the
/// TS layer returns via `completeMessage` when the handler settles.
type MessageDelivery = (String, String, String, Vec<u8>, f64); // id, fromId, fromName, body, ackId

/// Pending JS handler completions, keyed by ack id.
/// (`std::result::Result` spelled out: napi's `Result<T, S>` alias shadows
/// the std two-generic form in this module.)
type AckResult = std::result::Result<(), String>;

#[derive(Default)]
struct PendingAcks {
    senders: HashMap<u64, oneshot::Sender<AckResult>>,
}

/// THE message handler (ADR-0026): awaited — the Blob is acked only after
/// the JS handler settles (via `completeMessage`). A JS throw/rejection or a
/// dropped completion maps to `HandlerError::Failed`.
struct OnMessage {
    tsfn: FatalTsfn<MessageDelivery, DeliveryArgs>,
    pending: Arc<Mutex<PendingAcks>>,
    next_ack: Arc<AtomicU64>,
}

#[async_trait::async_trait]
impl TrueSealMessageHandler for OnMessage {
    async fn on_message(&self, message: TrueSealMessage) -> std::result::Result<(), HandlerError> {
        let ack_id = self.next_ack.fetch_add(1, AtomicOrdering::Relaxed);
        let (tx, rx) = oneshot::channel::<AckResult>();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.senders.insert(ack_id, tx);
        }
        let delivery: MessageDelivery = (
            message.id,
            message.from.id,
            message.from.name,
            message.body,
            ack_id as f64,
        );
        // napi 3 (TS-1): the sync NonBlocking call, not call_async —
        // call_async's future holds a raw napi value and is !Send, which the
        // core's handler trait forbids. The call returns Status immediately:
        // a non-Ok status means the dispatcher could not run (session
        // closing). The real settlement signal is the ack oneshot either way;
        // the dispatcher is infallible by construction, so nothing is lost by
        // not awaiting its completion.
        let dispatched = self.tsfn.call(delivery, ThreadsafeFunctionCallMode::NonBlocking);
        let result: AckResult = if dispatched == Status::Ok {
            // The dispatcher ran; now wait for the handler to settle.
            rx.await
                .unwrap_or_else(|_| Err("handler completion channel dropped".to_string()))
        } else {
            // The dispatcher itself could not run (session closing, ...).
            Err(format!("tsfn dispatch failed: {dispatched:?}"))
        };
        // Whether settled or failed, the slot is spent.
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        pending.senders.remove(&ack_id);
        result.map_err(|msg| HandlerError::Failed { msg })
    }
}

/// Bridges the core's single event stream onto one JS dispatcher callback
/// (JSON payload). The TS layer owns buffering and fan-out.
struct EventBridge {
    tsfn: FatalTsfn<String, String>,
}

impl TrueSealEventListener for EventBridge {
    fn on_event(&self, event: TrueSealEvent) {
        self.tsfn
            .call(event_json(&event), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

/// Bridges the core's delivery-issue stream onto one JS dispatcher callback.
struct IssueBridge {
    tsfn: FatalTsfn<String, String>,
}

impl TrueSealIssueListener for IssueBridge {
    fn on_delivery_issue(&self, issue: DeliveryIssue) {
        self.tsfn
            .call(issue_json(&issue), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

// ── CoreSession ───────────────────────────────────────────────────────────────

/// Internal NAPI wrapper around the core's canonical `TrueSeal` object.
///
/// This class is deliberately NOT part of the package's public types
/// (src/native-types.ts is internal; the public API is `TrueSeal` in
/// src/index.ts).
#[napi]
pub struct CoreSession {
    inner: Arc<TrueSeal>,
    pending: Arc<Mutex<PendingAcks>>,
    next_ack: Arc<AtomicU64>,
    // Subscriptions must outlive the registration: dropping one unregisters.
    // The message handler's subscription is droppable via
    // `cancelMessageHandler` (the TS Subscription.cancel()); one-shot is
    // still enforced — a dropped handler cannot be re-registered.
    handler_sub: Mutex<Option<Arc<Subscription>>>,
    _event_sub: Arc<Subscription>,
    _issue_sub: Arc<Subscription>,
}

#[napi]
impl CoreSession {
    /// Open a session on the canonical core object (ADR-0028).
    ///
    /// - `relay_address`     — the Relay Address string
    ///   (`trueseal://<relay public key hex>@host[:receivePort][?push=pushPort]`)
    /// - `base_dir`          — directory for the SQLite database
    /// - `namespace`         — scopes the DB file; one session per namespace
    /// - `max_payload_bytes` — optional creation-time payload-limit override
    ///   (can only lower the limit; ADR-0025)
    /// - `on_event`          — `(eventJson: string) => void`; MUST NOT throw
    /// - `on_delivery_issue` — `(issueJson: string) => void`; MUST NOT throw
    ///
    /// The relay connects in the background — the constructor never throws
    /// due to the relay being unreachable. It DOES throw typed errors
    /// (`invalidRelayAddress`, `invalidNamespace`, `storage`, `storeTooNew`).
    /// The message handler is registered separately via `onMessage`
    /// (registering it is what starts receiving — ADR-0026).
    #[napi(constructor)]
    pub fn new(
        env: Env,
        relay_address: String,
        base_dir: String,
        namespace: Option<String>,
        max_payload_bytes: Option<u32>,
        on_event: Function<String, Unknown<'static>>,
        on_delivery_issue: Function<String, Unknown<'static>>,
    ) -> Result<Self> {
        let mut tsfn_event: FatalTsfn<String, String> = on_event
            .build_threadsafe_function()
            .build_callback(|ctx| Ok(ctx.value))?;
        // unref: the TSFN must not keep the Node process alive. Deprecated
        // upstream since 2.17 in favor of clone() — but clone() does NOT
        // unref the event loop; napi_unref_threadsafe_function remains the
        // only way to get this behavior in napi 3.14.
        #[allow(deprecated)]
        tsfn_event.unref(&env)?;

        let mut tsfn_issue: FatalTsfn<String, String> = on_delivery_issue
            .build_threadsafe_function()
            .build_callback(|ctx| Ok(ctx.value))?;
        #[allow(deprecated)] // see tsfn_event above
        tsfn_issue.unref(&env)?;

        let inner = TrueSeal::open(relay_address, base_dir, namespace, max_payload_bytes)
            .map_err(|e| typed_err(&env, e))?;

        let event_sub = inner
            .on_event(Box::new(EventBridge { tsfn: tsfn_event }))
            .map_err(|e| typed_err(&env, e))?;
        let issue_sub = inner
            .on_delivery_issue(Box::new(IssueBridge { tsfn: tsfn_issue }))
            .map_err(|e| typed_err(&env, e))?;

        Ok(Self {
            inner,
            pending: Arc::new(Mutex::new(PendingAcks::default())),
            next_ack: Arc::new(AtomicU64::new(0)),
            handler_sub: Mutex::new(None),
            _event_sub: event_sub,
            _issue_sub: issue_sub,
        })
    }

    // ── State getters ─────────────────────────────────────────────────────────

    /// The group status (ADR-0028): one of the five canonical codes.
    #[napi]
    pub fn status(&self, env: Env) -> Result<String> {
        let status = self.inner.status().map_err(|e| typed_err(&env, e))?;
        Ok(group_status_code(status).to_string())
    }

    /// This device's member record (`{id, name}`).
    #[napi]
    pub fn me(&self, env: Env) -> Result<Member> {
        let me = self.inner.me().map_err(|e| typed_err(&env, e))?;
        Ok(Member {
            id: me.id,
            name: me.name,
        })
    }

    /// The connection state (ADR-0028), with `min`/`max` on
    /// `relayVersionUnsupported`.
    #[napi]
    pub fn connection(&self, env: Env) -> Result<ConnectionInfo> {
        let connection = self.inner.connection().map_err(|e| typed_err(&env, e))?;
        Ok(match connection {
            ConnectionState::RelayVersionUnsupported { min, max } => ConnectionInfo {
                state: "relayVersionUnsupported".to_string(),
                min: Some(min),
                max: Some(max),
            },
            ConnectionState::Connecting => ConnectionInfo {
                state: "connecting".to_string(),
                min: None,
                max: None,
            },
            ConnectionState::Connected => ConnectionInfo {
                state: "connected".to_string(),
                min: None,
                max: None,
            },
            ConnectionState::Disconnected => ConnectionInfo {
                state: "disconnected".to_string(),
                min: None,
                max: None,
            },
        })
    }

    // ── Receiving ─────────────────────────────────────────────────────────────

    /// Register THE message handler (ADR-0026/0028): one-shot per object,
    /// enforced by the CORE — a second call throws typed
    /// `messageHandlerAlreadySet`. Registering starts receiving.
    ///
    /// `callback(id, fromId, fromName, body, ackId) => void` — the TS layer
    /// runs the user's handler and signals settlement with
    /// `completeMessage(ackId, error?)`. The callback MUST NOT throw.
    #[napi]
    pub fn on_message(
        &self,
        env: Env,
        callback: Function<DeliveryArgs, Unknown<'static>>,
    ) -> Result<()> {
        let mut tsfn: FatalTsfn<MessageDelivery, DeliveryArgs> = callback
            .build_threadsafe_function()
            .build_callback(|ctx| {
                let (id, from_id, from_name, body, ack_id): MessageDelivery = ctx.value;
                Ok(FnArgs::from((id, from_id, from_name, Buffer::from(body), ack_id)))
            })?;
        #[allow(deprecated)] // see tsfn_event above
        tsfn.unref(&env)?;

        let sub = self
            .inner
            .on_message(Box::new(OnMessage {
                tsfn,
                pending: self.pending.clone(),
                next_ack: self.next_ack.clone(),
            }))
            .map_err(|e| typed_err(&env, e))?;
        let mut slot = self.handler_sub.lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(sub);
        Ok(())
    }

    /// Signal that the JS handler for `ack_id` settled. `error` non-null
    /// marks the attempt failed (the core retries per ADR-0026). Unknown or
    /// already-settled ids are ignored (a late completion after close()).
    #[napi]
    pub fn complete_message(&self, ack_id: f64, error: Option<String>) {
        let sender = {
            let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            pending.senders.remove(&(ack_id as u64))
        };
        if let Some(tx) = sender {
            let _ = tx.send(match error {
                Some(msg) => Err(msg),
                None => Ok(()),
            });
        }
    }

    /// Drop the message-handler registration (the TS Subscription.cancel()).
    /// One-shot is unaffected: a dropped handler cannot be re-registered
    /// (ADR-0028/SYNC-15) — the core still throws `messageHandlerAlreadySet`.
    #[napi]
    pub fn cancel_message_handler(&self) {
        let mut slot = self.handler_sub.lock().unwrap_or_else(|e| e.into_inner());
        *slot = None;
    }

    // ── Sending ───────────────────────────────────────────────────────────────

    /// Queue `blob` for fan-out to all current group members (ADR-0026).
    /// Returns the stable Message ID once the message is durably in the
    /// outbox. Throws typed `payloadTooLarge{max}` / `notMember{status}`.
    #[napi]
    pub fn send(&self, env: Env, blob: Buffer) -> Result<String> {
        self.inner
            .send(blob.to_vec())
            .map_err(|e| typed_err(&env, e))
    }

    // ── Pairing, admitting side ───────────────────────────────────────────────

    /// Open a Pairing Window and return the Pairing Token.
    /// Pass the token to the peer's `join(token)`.
    #[napi]
    pub fn start_pairing(&self, env: Env) -> Result<String> {
        self.inner.start_pairing().map_err(|e| typed_err(&env, e))
    }

    /// Admit a pending member by the opaque `requestId` from a `joinRequest`
    /// event. Throws typed `pairingClosed` when the window is closed or the
    /// request id is unknown, `groupFull{max}` at the cap (ADR-0023/0027/0028).
    #[napi]
    pub fn accept(&self, env: Env, request_id: String) -> Result<()> {
        self.inner
            .accept(request_id)
            .map_err(|e| typed_err(&env, e))
    }

    /// Close the Pairing Window without admitting any device.
    #[napi]
    pub fn cancel_pairing(&self, env: Env) -> Result<()> {
        self.inner.cancel_pairing().map_err(|e| typed_err(&env, e))
    }

    // ── Pairing, joining side ─────────────────────────────────────────────────

    /// Join a group as the responding device using the initiator's token.
    /// Moves the device to `pendingJoin`; throws typed `alreadyInGroup` or
    /// `invalidPairingToken`.
    #[napi]
    pub fn join(&self, env: Env, token: String) -> Result<()> {
        self.inner.join(token).map_err(|e| typed_err(&env, e))
    }

    /// Abandon a Pending Join; the device returns to `notJoined` (ADR-0023).
    #[napi]
    pub fn cancel_join(&self, env: Env) -> Result<()> {
        self.inner.cancel_join().map_err(|e| typed_err(&env, e))
    }

    // ── Membership ────────────────────────────────────────────────────────────

    /// List remote group members (excludes the local device).
    #[napi]
    pub fn members(&self, env: Env) -> Result<Vec<Member>> {
        let members = self.inner.members().map_err(|e| typed_err(&env, e))?;
        Ok(members
            .into_iter()
            .map(|m| Member {
                id: m.id,
                name: m.name,
            })
            .collect())
    }

    /// Remove a group member by their opaque `memberId` from `members()`.
    #[napi]
    pub fn remove(&self, env: Env, member_id: String) -> Result<()> {
        self.inner
            .remove(member_id)
            .map_err(|e| typed_err(&env, e))
    }

    /// Leave the group: the device moves to `leaving`, and to `notJoined`
    /// with reason `left` once the Relay has accepted the Leave (ADR-0027).
    #[napi]
    pub fn leave(&self, env: Env) -> Result<()> {
        self.inner.leave().map_err(|e| typed_err(&env, e))
    }

    // ── Destroy ───────────────────────────────────────────────────────────────

    /// Destroy the group — queue a durable, forwarded Revoke to all members
    /// (ADR-0029); the wipe fires when the relay has accepted every Revoke.
    #[napi]
    pub fn destroy_group(&self, env: Env) -> Result<()> {
        self.inner.destroy_group().map_err(|e| typed_err(&env, e))
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /// Stop the connection and handlers; keep Session State (ADR-0028).
    /// Idempotent. After `close()`, every call throws typed `closed`.
    #[napi]
    pub fn close(&self) {
        self.inner.close();
        // Release any parked JS-handler completions with Ok(()) — NOT an
        // error. The core's attempt loop has a purpose-built graceful path
        // for exactly this (session/mod.rs, the SYNC-15 F2 semantics): an
        // Ok(()) resolution with the shutdown flag set abandons the
        // delivery UNRECORDED — no failed attempt, no backoff, no
        // re-invocation of the user's handler, no spurious handlerGaveUp;
        // the ack never leaves the severed session and the relay
        // re-delivers on the next open(). Draining with Err would count a
        // FAILED attempt and burn all five on a dying session. Ordering is
        // correct: inner.close() sets the shutdown flag before the drain.
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        for (_, tx) in pending.senders.drain() {
            let _ = tx.send(Ok(()));
        }
    }
}

// ── Module-level functions ────────────────────────────────────────────────────

/// Parse a Relay Address string into the typed form (ADR-0028). Strict:
/// the scheme is mandatory, the key is exactly 64 hex chars (uppercase
/// accepted), the host never contains `@`, IPv6 hosts are bracketed, and
/// `push=` is the only query parameter. Throws typed `invalidRelayAddress`.
#[napi]
pub fn parse_relay_address(env: Env, input: String) -> Result<ParsedAddress> {
    let parsed = CoreRelayAddress::parse(&input)
        .map_err(|e| typed_err(&env, CoreError::InvalidRelayAddress { msg: e.0 }))?;
    Ok(ParsedAddress {
        host: parsed.host,
        public_key: Buffer::from(parsed.public_key.0.to_vec()),
        receive_port: parsed.receive_port as u32,
        push_port: parsed.push_port as u32,
    })
}

/// The version triple for this build: `{sdkVersion, transportVersion,
/// endToEndVersion}`, from the core constants (ADR-0022/0030).
#[napi]
pub fn trueseal_info() -> Info {
    let info = trueseal_sync::ffi::trueseal_info();
    Info {
        sdk_version: info.sdk_version,
        transport_version: info.transport_version,
        end_to_end_version: info.end_to_end_version,
    }
}

/// The Protocol Size Limit (61,440 bytes, ADR-0025), from the core constant.
#[napi]
pub fn trueseal_max_payload_bytes() -> u32 {
    trueseal_sync::ffi::trueseal_max_payload_bytes()
}

/// The Maximum Group Size (32, ADR-0027), from the core constant.
#[napi]
pub fn trueseal_max_group_size() -> u32 {
    trueseal_sync::ffi::trueseal_max_group_size()
}
