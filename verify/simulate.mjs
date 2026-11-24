// Local end-to-end test: contributors take turns through the coordinator exactly
// as the web page does, and one of them cheats (uploads a key built on nothing).
//   node verify/simulate.mjs http://127.0.0.1:8799
import * as snarkjs from 'snarkjs'
import { randomBytes } from 'node:crypto'

const U = process.argv[2]
const j = async (r) => {
  const b = await r.json()
  if (!r.ok) throw new Error(JSON.stringify(b))
  return b
}

async function contribute(name, cheat = false) {
  const { ticket } = await j(await fetch(`${U}/join`, { method: 'POST', body: JSON.stringify({ name }) }))
  let t
  while (!(t = await j(await fetch(`${U}/turn?ticket=${ticket}`))).turn) await new Promise((r) => setTimeout(r, 500))
  const old = { type: 'mem', data: new Uint8Array(await (await fetch(`${U}/zkey`)).arrayBuffer()) }
  const next = { type: 'mem' }
  // the cheat skips the real key and contributes on a fresh start instead
  const base = cheat ? { type: 'mem', data: new Uint8Array(await (await import('node:fs')).promises.readFile('../circuits/build/transact_0000.zkey')) } : old
  const hash = Buffer.from(await snarkjs.zKey.contribute(base, next, name, randomBytes(32).toString('hex'))).toString('hex')
  await j(await fetch(`${U}/contribute?ticket=${ticket}`, { method: 'PUT', headers: { 'x-contribution-hash': hash }, body: next.data }))
  console.log(`${name}: uploaded #${t.n} ${hash.slice(0, 16)}...`)
  return { ticket, n: t.n, hash }
}

export { contribute }
if (process.argv[3] === 'one') { await contribute(process.argv[4] || 'tester', process.argv[5] === 'cheat'); process.exit(0) }
