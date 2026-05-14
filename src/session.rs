// NAPI-RS glue wrapping hush_sync::ffi::HushFfiSession.
//
// All callbacks that can fire from background threads use ThreadsafeFunction so
// they are safely marshalled back onto the JS event loop.
//
// Every TSFN is `unref()`-ed after creation so it does not prevent the Node.js
// process from exiting when all other work is done (mirrors Node's own
// `emitter.unref()` convention for background handles).

use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use hush_sync::ffi::{
    ConnectionChangedCallback, GroupDestroyedCallback, HushFfiSession,
    MemberJoinedCallback, MemberLeftCallback, MemberRequestCallback, MessageCallback,
    RemovedFromGroupCallback, SessionError as CoreError,
};

// ── Error mapping ─────────────────────────────────────────────────────────────

fn core_err(e: CoreError) -> napi::Error {
    napi::Error::new(napi::Status::GenericFailure, e.to_string())
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

// ── Callback wrapper structs ──────────────────────────────────────────────────
// UniFFI callback interfaces require concrete struct impls, not plain closures.

struct OnMessage(ThreadsafeFunction<(Vec<u8>, Vec<u8>), ErrorStrategy::Fatal>);
impl MessageCallback for OnMessage {
    fn on_message(&self, blob: Vec<u8>, sender_noise_pub: Vec<u8>) {
        self.0
            .call((blob, sender_noise_pub), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

struct OnRemovedFromGroup(ThreadsafeFunction<(), ErrorStrategy::Fatal>);
impl RemovedFromGroupCallback for OnRemovedFromGroup {
    fn on_removed_from_group(&self) {
        self.0.call((), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

struct OnGroupDestroyed(ThreadsafeFunction<(), ErrorStrategy::Fatal>);
impl GroupDestroyedCallback for OnGroupDestroyed {
    fn on_group_destroyed(&self) {
        self.0.call((), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

struct OnConnectionChanged(ThreadsafeFunction<bool, ErrorStrategy::Fatal>);
impl ConnectionChangedCallback for OnConnectionChanged {
    fn on_connection_changed(&self, connected: bool) {
        self.0.call(connected, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

struct OnMemberRequest(ThreadsafeFunction<(String, String), ErrorStrategy::Fatal>);
impl MemberRequestCallback for OnMemberRequest {
    fn on_member_request(&self, token: String, name: String) {
        self.0.call((token, name), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

struct OnMemberJoined(ThreadsafeFunction<(String, String), ErrorStrategy::Fatal>);
impl MemberJoinedCallback for OnMemberJoined {
    fn on_member_joined(&self, member_id: String, member_name: String) {
        self.0
            .call((member_id, member_name), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

struct OnMemberLeft(ThreadsafeFunction<(String, String), ErrorStrategy::Fatal>);
impl MemberLeftCallback for OnMemberLeft {
    fn on_member_left(&self, member_id: String, member_name: String) {
        self.0
            .call((member_id, member_name), ThreadsafeFunctionCallMode::NonBlocking);
    }
}

// ── HushSession ───────────────────────────────────────────────────────────────

#[napi]
pub struct HushSession {
    inner: Arc<HushFfiSession>,
}

#[napi]
impl HushSession {
    /// Create a new session.
    ///
    /// - `base_dir`       — directory for the SQLite database
    /// - `namespace`      — scopes the DB file; one session per namespace
    /// - `relay_host`     — relay hostname or IP (no port)
    /// - `relay_pub`      — 32-byte X25519 relay public key as a Buffer
    /// - `on_message`     — `(blob: Buffer, senderId: string) => void`
    /// - `on_removed_from_group` — `() => void`
    /// - `on_group_destroyed`    — `() => void`
    /// - `on_connection_changed` — `(connected: boolean) => void` (optional)
    ///
    /// The relay connects in the background — constructor never throws due to
    /// the relay being unreachable.
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
        // ── Build thread-safe callbacks (all unref-ed) ────────────────────────

        let mut tsfn_message: ThreadsafeFunction<(Vec<u8>, Vec<u8>), ErrorStrategy::Fatal> =
            on_message.create_threadsafe_function(0, |ctx| {
                let (blob, sender): (Vec<u8>, Vec<u8>) = ctx.value;
                let sender_id = bytes_to_base64url(&sender);
                Ok(vec![
                    ctx.env.create_buffer_with_data(blob)?.into_unknown(),
                    ctx.env.create_string(&sender_id)?.into_unknown(),
                ])
            })?;
        tsfn_message.unref(&env)?;

        let mut tsfn_removed: ThreadsafeFunction<(), ErrorStrategy::Fatal> =
            on_removed_from_group.create_threadsafe_function(0, |ctx| {
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

        // ── Construct inner session ───────────────────────────────────────────

        let inner = HushFfiSession::create(
            base_dir,
            namespace,
            relay_host,
            relay_pub.to_vec(),
            Box::new(OnMessage(tsfn_message)),
            Box::new(OnRemovedFromGroup(tsfn_removed)),
            Box::new(OnGroupDestroyed(tsfn_destroyed)),
            tsfn_conn.map(|tsfn| -> Box<dyn ConnectionChangedCallback> {
                Box::new(OnConnectionChanged(tsfn))
            }),
        )
        .map_err(core_err)?;

        Ok(Self { inner })
    }

    // ── Pairing ───────────────────────────────────────────────────────────────

    /// Open a pairing window and return an opaque base64url token.
    /// Pass the token to the peer's `joinGroup(token)`.
    #[napi]
    pub fn pairing_token(&self) -> String {
        self.inner.pairing_token()
    }

    /// Join a group as the responding device using the initiator's token.
    #[napi]
    pub fn join_group(&self, token: String) -> Result<()> {
        self.inner.join_group(token).map_err(core_err)
    }

    /// Register a callback fired when a `Pair` message arrives within an open
    /// pairing window. `callback(requestToken: string, name: string) => void`.
    #[napi]
    pub fn set_on_member_request(&self, env: Env, callback: JsFunction) -> Result<()> {
        let mut tsfn: ThreadsafeFunction<(String, String), ErrorStrategy::Fatal> = callback
            .create_threadsafe_function(0, |ctx| {
                let (token, name): (String, String) = ctx.value;
                Ok(vec![
                    ctx.env.create_string(&token)?.into_unknown(),
                    ctx.env.create_string(&name)?.into_unknown(),
                ])
            })?;
        tsfn.unref(&env)?;
        self.inner
            .set_on_member_request(Box::new(OnMemberRequest(tsfn)));
        Ok(())
    }

    /// Admit a pending member by their opaque request token from `onMemberRequest`.
    /// Returns `true` if admitted.
    #[napi]
    pub fn accept_member(&self, token: String) -> bool {
        self.inner.accept_member(token)
    }

    /// Register a callback fired when a new member joins the group.
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
        self.inner
            .set_on_member_joined(Box::new(OnMemberJoined(tsfn)));
        Ok(())
    }

    /// Register a callback fired when a member is soft-removed from the group.
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
        self.inner
            .set_on_member_left(Box::new(OnMemberLeft(tsfn)));
        Ok(())
    }

    /// Close the pairing window without admitting any device.
    #[napi]
    pub fn cancel_pairing(&self) {
        self.inner.cancel_pairing()
    }

    // ── Identity ──────────────────────────────────────────────────────────────

    /// Stable opaque identifier for the local device.
    #[napi]
    pub fn local_node_id(&self) -> String {
        self.inner.local_node_id()
    }

    /// Auto-generated display name for the local device.
    #[napi]
    pub fn local_device_name(&self) -> String {
        self.inner.local_device_name()
    }

    // ── Group ─────────────────────────────────────────────────────────────────

    /// List remote group members (excludes the local device).
    #[napi]
    pub fn members(&self) -> Vec<Member> {
        self.inner
            .members()
            .into_iter()
            .map(|m| Member {
                id: m.id,
                name: m.name,
            })
            .collect()
    }

    /// Remove a group member by their opaque `memberId` from `members()`.
    #[napi]
    pub fn remove_member(&self, member_id: String) -> Result<()> {
        self.inner.remove_member(member_id).map_err(core_err)
    }

    // ── Sync ──────────────────────────────────────────────────────────────────

    /// Encrypt `blob` and fan out to all current group members.
    #[napi]
    pub fn send(&self, blob: Buffer) -> Result<()> {
        self.inner.send(blob.to_vec()).map_err(core_err)
    }

    // ── Destroy ───────────────────────────────────────────────────────────────

    /// Destroy the group — push Revoke to all members and wipe local state.
    /// Session becomes terminal after this call.
    #[napi]
    pub fn destroy_group(&self) {
        self.inner.destroy_group()
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Encode raw bytes as a URL-safe base64 string (no padding).
fn bytes_to_base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity((bytes.len() * 4 + 2) / 3);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(ALPHABET[b0 >> 2] as char);
        out.push(ALPHABET[((b0 & 3) << 4) | (b1 >> 4)] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((b1 & 0xf) << 2) | (b2 >> 6)] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[b2 & 0x3f] as char);
        }
    }
    out
}
