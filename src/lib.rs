#![deny(clippy::all)]

use napi_derive::napi;

/// Returns the crate version. Used as a build-chain smoke test.
#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
