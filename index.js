'use strict'

const { platform, arch } = process

const platforms = {
  'darwin-arm64':  'hush-sync-ts.darwin-arm64.node',
  'darwin-x64':   'hush-sync-ts.darwin-x64.node',
  'linux-x64':    'hush-sync-ts.linux-x64-gnu.node',
  'win32-x64':    'hush-sync-ts.win32-x64-msvc.node',
}

const key = `${platform}-${arch}`
const binding = platforms[key]

if (!binding) {
  throw new Error(`Unsupported platform: ${key}. Supported: ${Object.keys(platforms).join(', ')}`)
}

// Try local build first (dev), then fall back to installed optional dep.
let nativeModule
try {
  nativeModule = require(`./${binding}`)
} catch (_localErr) {
  throw new Error(
    `Failed to load native binding for ${key}.\n` +
    `Run \`npm run build\` to compile from source.\n`
  )
}

module.exports = nativeModule
