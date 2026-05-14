import { HushSyncClient } from './dist/index.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'

const RELAY_PUB = Buffer.from('3f783127c25c91ac8ea02ab97edca78e5708e0c686fa0cc2e714c135c7cd095e', 'hex')
const TMP = () => mkdtempSync(join(tmpdir(), 'hush-dbg-'))
const waitFor = (em, ev, ms = 6000) => new Promise((res, rej) => {
  em.once(ev, (...a) => res(a))
  setTimeout(() => rej(new Error('timeout: ' + ev)), ms)
})

const a = await HushSyncClient.create({ relayHost: 'localhost', relayPublicKey: RELAY_PUB, storageDir: TMP(), namespace: 'dbg' })
const connA = waitFor(a, 'connectionChanged')
const b = await HushSyncClient.create({ relayHost: 'localhost', relayPublicKey: RELAY_PUB, storageDir: TMP(), namespace: 'dbg' })
const connB = waitFor(b, 'connectionChanged')

b.on('message', (blob, sender) => {
  console.log('✅ B got message:', blob.toString(), 'from', sender)
  process.exit(0)
})

const [ca] = await connA; console.log('A connected:', ca)
const [cb] = await connB; console.log('B connected:', cb)

const token = a.pairingToken()
const joinedA = waitFor(a, 'memberJoined')
const joinedB = waitFor(b, 'memberJoined')
const reqP = new Promise(res => a.onMemberRequest((t, n) => { console.log('request from:', n); res(t) }))
b.joinGroup(token)

const reqToken = await reqP
a.acceptPairingRequest(reqToken)
await joinedA; console.log('A memberJoined. members:', a.members.map(m => m.name))
await joinedB; console.log('B memberJoined. members:', b.members.map(m => m.name))

console.log('sending...')
try {
  await a.send(Buffer.from('hello from A'))
  console.log('send() returned OK')
} catch (e) {
  console.error('send() threw:', e.message)
  process.exit(1)
}

setTimeout(() => { console.log('❌ TIMEOUT — message never arrived on B'); process.exit(1) }, 5000)
