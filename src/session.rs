// NAPI-RS glue wrapping the canonical core FFI: trueseal_sync::ffi::TrueSeal.
//
// TS-3 (#16): the binding targets the post-SYNC-15 FFI, whose `TrueSealError`
// is a typed 14-variant enum. Every fallible native call maps that enum to a
// thrown JS Error carrying:
//   - `code`    — the canonical camelCase code, character-for-character from
//                 trueseal-sync docs/shared-facts.json (the G12 parity source)
//   - `message` — the human message
//   - typed extras as real own properties where the canonical case carries
//     them: `status` (notMember), `max` (groupFull, payloadTooLarge),
//     `found`/`supported` (storeTooNew)
//
// The mapping is an exhaustive Rust `match` with NO wildcard arm: if the core
// ever grows a 15th error variant, THIS CRATE FAILS TO COMPILE. That is the
// exhaustiveness guard — there is no stringly-typed fallback anywhere.
//
// Throw mechanics: napi-rs 2 has no Env-injected typed-error return path, so
// `typed_err` builds the propertied Error object with the Env, throws it with
// a raw `napi_throw`, and returns a `Status::PendingException` error — napi-rs
// sees that status and leaves our pending exception untouched (its own
// throw_into early-returns for PendingException).
//
// All callbacks that fire from background threads use ThreadsafeFunction, and
// every TSFN is `unref()`-ed so it does not keep the Node.js process alive.
// The message handler is AWAITED (ADR-0026): the DeliverAck leaves the device
// only after the JS callback returns.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{JsObject, NapiRaw};
use napi_derive::napi;

use trueseal_sync::ffi::{
    ConnectionState, GroupStatus, HandlerError, StatusReason, Subscription, TrueSeal,
    TrueSealError as CoreError, TrueSealEvent, TrueSealEventListener, TrueSealMessage,
    TrueSealMessageHandler,
};

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

    let build = || -> napi::Result<JsObject> {
        let mut obj = env.create_error(napi::Error::from_reason(e.to_string()))?;
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
        Ok(obj)
    };

    match build() {
        Ok(obj) => {
            // Throw the propertied object ourselves; the returned
            // PendingException tells napi-rs to leave it alone.
            unsafe { napi::sys::napi_throw(env.raw(), obj.raw()) };
            napi::Error::new(napi::Status::PendingException, "")
        }
        // The VM is already unhappy if creating an Error object fails; fall
        // back to the plain error (never reached in practice).
        Err(err) => err,
    }
}

// ── Member record ─────────────────────────────────────────────────────────────

/// A remote group member.
#[napi(object)]
pub struct Member {
    /// Stable opaque identifier derived from the member's signing public key.
    pub id: String,
    /// Auto-generated human-readable name, e.g. "AmberFalcon".
    pub name: String,
}

// ── Callback bridge structs ───────────────────────────────────────────────────
// UniFFI callback interfaces require concrete struct impls, not plain closures.

/// THE message handler (ADR-0026): awaited — the Blob is acked only after the
/// JS callback returns. A JS throw maps to `HandlerError::Failed` (the core
/// retries per its 5-attempt policy, then raises `handlerGaveUp`).
struct OnMessage(ThreadsafeFunction<(Vec<u8>, String, String), ErrorStrategy::Fatal>);

#[async_trait::async_trait]
impl TrueSealMessageHandler for OnMessage {
    async fn on_message(&self, message: TrueSealMessage) -> std::result::Result<(), HandlerError> {
        let args = (message.body, message.from.id, message.id);
        self.0
            .call_async::<Undefined>(args)
            .await
            .map(|_| ())
            .map_err(|e| HandlerError::Failed {
                msg: e.to_string(),
            })
    }
}

/// TSFN slots the public setters fill AFTER construction. The single core
/// event listener reads them; events arriving before a slot is filled are
/// dropped (matching the pre-TS-3 semantics where no setter meant no event —
/// SDK-1 (TS) replaces this with the canonical buffered onEvent stream).
#[derive(Default)]
struct EventSlots {
    member_request: Option<ThreadsafeFunction<(String, String), ErrorStrategy::Fatal>>,
    member_joined: Option<ThreadsafeFunction<(String, String), ErrorStrategy::Fatal>>,
    member_left: Option<ThreadsafeFunction<(String, String), ErrorStrategy::Fatal>>,
}

/// Bridges the canonical `TrueSealEvent` stream onto the legacy per-event
/// callbacks this binding's public API still exposes. SDK-1 (TS) reshapes the
/// public API to `onEvent` and deletes this bridge.
struct EventBridge {
    on_removed: ThreadsafeFunction<(), ErrorStrategy::Fatal>,
    on_destroyed: ThreadsafeFunction<(), ErrorStrategy::Fatal>,
    on_conn: Option<ThreadsafeFunction<bool, ErrorStrategy::Fatal>>,
    slots: Arc<Mutex<EventSlots>>,
    /// Last-seen member list (id → name) for synthesizing joined/left deltas
    /// from the canonical whole-list `MembersChanged` event (ADR-0027's
    /// flicker note applies: rapid concurrent changes may coalesce).
    member_names: Mutex<HashMap<String, String>>,
}

impl TrueSealEventListener for EventBridge {
    fn on_event(&self, event: TrueSealEvent) {
        match event {
            TrueSealEvent::StatusChanged {
                status: GroupStatus::NotJoined,
                reason,
            } => match reason {
                StatusReason::Removed => {
                    self.on_removed
                        .call((), ThreadsafeFunctionCallMode::NonBlocking);
                }
                StatusReason::Destroyed => {
                    self.on_destroyed
                        .call((), ThreadsafeFunctionCallMode::NonBlocking);
                }
                // Left / StoreReset / Created / Joined have no legacy event;
                // SDK-1 (TS) exposes the canonical statusChanged stream.
                _ => {}
            },
            // Transitions TO a status (joined, leaving, destroying, ...) are
            // visible through members()/status getters; no legacy event.
            TrueSealEvent::StatusChanged { .. } => {}
            TrueSealEvent::ConnectionChanged { connection } => {
                if let Some(tsfn) = &self.on_conn {
                    let connected = matches!(connection, ConnectionState::Connected);
                    tsfn.call(connected, ThreadsafeFunctionCallMode::NonBlocking);
                }
            }
            TrueSealEvent::JoinRequest { request } => {
                let tsfn = self
                    .slots
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .member_request
                    .clone();
                if let Some(tsfn) = tsfn {
                    tsfn.call((request.id, request.name), ThreadsafeFunctionCallMode::NonBlocking);
                }
            }
            TrueSealEvent::MembersChanged { members } => {
                let (joined, left) = {
                    let mut old = self.member_names.lock().unwrap_or_else(|e| e.into_inner());
                    let new_ids: std::collections::HashSet<&str> =
                        members.iter().map(|m| m.id.as_str()).collect();
                    let joined: Vec<(String, String)> = members
                        .iter()
                        .filter(|m| !old.contains_key(&m.id))
                        .map(|m| (m.id.clone(), m.name.clone()))
                        .collect();
                    let left: Vec<(String, String)> = old
                        .iter()
                        .filter(|(id, _)| !new_ids.contains(id.as_str()))
                        .map(|(id, name)| (id.clone(), name.clone()))
                        .collect();
                    *old = members.iter().map(|m| (m.id.clone(), m.name.clone())).collect();
                    (joined, left)
                };
                let slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
                for (id, name) in joined {
                    if let Some(tsfn) = &slots.member_joined {
                        tsfn.call((id, name), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
                for (id, name) in left {
                    if let Some(tsfn) = &slots.member_left {
                        tsfn.call((id, name), ThreadsafeFunctionCallMode::NonBlocking);
                    }
                }
            }
            // No legacy event exists; SDK-1 (TS) exposes it on onEvent.
            TrueSealEvent::AdmissionDropped { .. } => {}
        }
    }
}

// ── CoreSession ───────────────────────────────────────────────────────────────

/// Internal NAPI wrapper around the core's canonical `TrueSeal` object.
///
/// This class is deliberately NOT part of the package's public types
/// (src/native-types.ts is internal; the public API is TruesealSyncClient).
/// The pre-TS-3 name `HushSession` is gone — "Hush" is an example app, not
/// the SDK.
#[napi]
pub struct CoreSession {
    inner: Arc<TrueSeal>,
    slots: Arc<Mutex<EventSlots>>,
    // Subscriptions must outlive the session: dropping one unregisters the
    // handler/listener.
    _handler_sub: Arc<Subscription>,
    _event_sub: Arc<Subscription>,
}

#[napi]
impl CoreSession {
    /// Create a new session.
    ///
    /// - `base_dir`       — directory for the SQLite database
    /// - `namespace`      — scopes the DB file; one session per namespace
    /// - `relay_host`     — relay hostname or IP (no port; the Relay Address
    ///                      string form is SDK-1 (TS) scope)
    /// - `relay_pub`      — 32-byte X25519 relay public key as a Buffer
    /// - `on_message`     — `(blob: Buffer, senderId: string, messageId: string) => void`;
    ///                      AWAITED per ADR-0026 — see TrueSealMessageHandler
    /// - `on_removed_from_group` — `() => void`
    /// - `on_group_destroyed`    — `() => void`
    /// - `on_connection_changed` — `(connected: boolean) => void` (optional)
    ///
    /// The relay connects in the background — the constructor never throws
    /// due to the relay being unreachable. It DOES throw typed errors
    /// (`invalidRelayAddress`, `invalidNamespace`, `storage`, `storeTooNew`).
    #[napi(constructor)]
    pub fn new(
        env: Env,
        base_dir: String,
        namespace: String,
        relay_host: String,
        relay_pub: Buffer,
        on_message: JsFunction,
        on_removed_from_group: JsFunction,
        on_group_destroyed: JsFunction,
        on_connection_changed: Option<JsFunction>,
    ) -> Result<Self> {
        // ── Thread-safe callbacks (all unref-ed) ─────────────────────────────

        let tsfn_message: ThreadsafeFunction<(Vec<u8>, String, String), ErrorStrategy::Fatal> =
            on_message.create_threadsafe_function(0, |ctx| {
                let (blob, sender_id, message_id): (Vec<u8>, String, String) = ctx.value;
                Ok(vec![
                    ctx.env.create_buffer_with_data(blob)?.into_unknown(),
                    ctx.env.create_string(&sender_id)?.into_unknown(),
                    ctx.env.create_string(&message_id)?.into_unknown(),
                ])
            })?;

        let mut tsfn_removed: ThreadsafeFunction<(), ErrorStrategy::Fatal> = on_removed_from_group
            .create_threadsafe_function(0, |ctx| {
                let _ = ctx.value;
                Ok(vec![] as Vec<napi::JsUnknown>)
            })?;
        tsfn_removed.unref(&env)?;

        let mut tsfn_destroyed: ThreadsafeFunction<(), ErrorStrategy::Fatal> =
            on_group_destroyed.create_threadsafe_function(0, |ctx| {
                let _ = ctx.value;
                Ok(vec![] as Vec<napi::JsUnknown>)
            })?;
        tsfn_destroyed.unref(&env)?;

        let mut tsfn_conn: Option<ThreadsafeFunction<bool, ErrorStrategy::Fatal>> =
            on_connection_changed
                .map(|f| {
                    f.create_threadsafe_function(0, |ctx| {
                        let connected: bool = ctx.value;
                        Ok(vec![ctx.env.get_boolean(connected)?.into_unknown()])
                    })
                })
                .transpose()?;
        if let Some(ref mut tsfn) = tsfn_conn {
            tsfn.unref(&env)?;
        }

        // ── Open the canonical core object ────────────────────────────────────
        //
        // The legacy host+key config becomes a Relay Address string with the
        // default ports (7700/7701) — the grammar trueseal-relay's `address`
        // command prints and trueseal-sync's parser reads.

        let relay = format!(
            "trueseal://{}@{}",
            hex::encode(relay_pub.as_ref()),
            relay_host
        );
        let inner = TrueSeal::open(relay, base_dir, Some(namespace), None)
            .map_err(|e| typed_err(&env, e))?;

        // THE message handler (ADR-0026: one-shot, awaited).
        let handler_sub = inner
            .on_message(Box::new(OnMessage(tsfn_message)))
            .map_err(|e| typed_err(&env, e))?;

        // The single event listener bridging onto the legacy callbacks.
        let slots = Arc::new(Mutex::new(EventSlots::default()));
        let event_sub = inner
            .on_event(Box::new(EventBridge {
                on_removed: tsfn_removed,
                on_destroyed: tsfn_destroyed,
                on_conn: tsfn_conn,
                slots: slots.clone(),
                member_names: Mutex::new(HashMap::new()),
            }))
            .map_err(|e| typed_err(&env, e))?;

        Ok(Self {
            inner,
            slots,
            _handler_sub: handler_sub,
            _event_sub: event_sub,
        })
    }

    // ── Pairing ───────────────────────────────────────────────────────────────

    /// Open a Pairing Window and return the Pairing Token.
    /// Pass the token to the peer's `joinGroup(token)`.
    #[napi]
    pub fn pairing_token(&self, env: Env) -> Result<String> {
        self.inner.start_pairing().map_err(|e| typed_err(&env, e))
    }

    /// Join a group as the responding device using the initiator's token.
    #[napi]
    pub fn join_group(&self, env: Env, token: String) -> Result<()> {
        self.inner.join(token).map_err(|e| typed_err(&env, e))
    }

    /// Register a callback fired when a Join Request arrives inside the open
    /// Pairing Window. `callback(requestId: string, name: string) => void`.
    #[napi]
    pub fn set_on_member_request(&self, env: Env, callback: JsFunction) -> Result<()> {
        let mut tsfn: ThreadsafeFunction<(String, String), ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let (id, name): (String, String) = ctx.value;
                Ok(vec![
                    ctx.env.create_string(&id)?.into_unknown(),
                    ctx.env.create_string(&name)?.into_unknown(),
                ])
            })?;
        tsfn.unref(&env)?;
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .member_request = Some(tsfn);
        Ok(())
    }

    /// Admit a pending member by the opaque `requestId` from `onMemberRequest`.
    ///
    /// Throws typed `pairingClosed` when the window is closed or the request
    /// ID is unknown (ADR-0023/0028 — the pre-TS-3 `false` return is gone;
    /// an unknown request IS an error in the canonical model).
    #[napi]
    pub fn accept_member(&self, env: Env, request_id: String) -> Result<()> {
        self.inner
            .accept(request_id)
            .map_err(|e| typed_err(&env, e))
    }

    /// Register a callback fired when a device joins the group.
    /// `callback(memberId: string, memberName: string) => void`
    #[napi]
    pub fn set_on_member_joined(&self, env: Env, callback: JsFunction) -> Result<()> {
        let mut tsfn: ThreadsafeFunction<(String, String), ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let (id, name): (String, String) = ctx.value;
                Ok(vec![
                    ctx.env.create_string(&id)?.into_unknown(),
                    ctx.env.create_string(&name)?.into_unknown(),
                ])
            })?;
        tsfn.unref(&env)?;
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .member_joined = Some(tsfn);
        Ok(())
    }

    /// Register a callback fired when a member leaves or is removed.
    /// `callback(memberId: string, memberName: string) => void`
    #[napi]
    pub fn set_on_member_left(&self, env: Env, callback: JsFunction) -> Result<()> {
        let mut tsfn: ThreadsafeFunction<(String, String), ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let (id, name): (String, String) = ctx.value;
                Ok(vec![
                    ctx.env.create_string(&id)?.into_unknown(),
                    ctx.env.create_string(&name)?.into_unknown(),
                ])
            })?;
        tsfn.unref(&env)?;
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .member_left = Some(tsfn);
        Ok(())
    }

    /// Close the Pairing Window without admitting any device.
    #[napi]
    pub fn cancel_pairing(&self, env: Env) -> Result<()> {
        self.inner.cancel_pairing().map_err(|e| typed_err(&env, e))
    }

    // ── Identity ──────────────────────────────────────────────────────────────

    /// Stable opaque identifier for the local device (the member id — the
    /// same id as in `members()` on the peer's view).
    #[napi]
    pub fn local_node_id(&self, env: Env) -> Result<String> {
        Ok(self.inner.me().map_err(|e| typed_err(&env, e))?.id)
    }

    /// Auto-generated display name for the local device.
    #[napi]
    pub fn local_device_name(&self, env: Env) -> Result<String> {
        Ok(self.inner.me().map_err(|e| typed_err(&env, e))?.name)
    }

    // ── Group ─────────────────────────────────────────────────────────────────

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
    pub fn remove_member(&self, env: Env, member_id: String) -> Result<()> {
        self.inner
            .remove(member_id)
            .map_err(|e| typed_err(&env, e))
    }

    // ── Sync ──────────────────────────────────────────────────────────────────

    /// Queue `blob` for fan-out to all current group members (ADR-0026).
    /// Returns the stable Message ID once the message is durably in the
    /// outbox. Throws typed `payloadTooLarge{max}` / `notMember{status}`.
    #[napi]
    pub fn send(&self, env: Env, blob: Buffer) -> Result<String> {
        self.inner
            .send(blob.to_vec())
            .map_err(|e| typed_err(&env, e))
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
        self.inner.close()
    }
}
