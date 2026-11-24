// The ceremony's public verifier. It runs as a GitHub Action in this repository,
// so every check is visible to everyone, and it is the only thing that can turn
// a contribution into the next "latest" key.
//
// For each contribution waiting at the coordinator it:
//   1. downloads the new key,
//   2. checks the whole key from scratch against the circuit (transact.r1cs) and
//      the public phase 1 file (Perpetual Powers of Tau), with snarkjs,
//   3. checks it keeps every earlier accepted contribution and adds exactly one,
//   4. archives the key as a release asset and adds a line to TRANSCRIPT.md,
//   5. tells the coordinator to accept it (or reject it).
//
//   CEREMONY_URL=... VERIFIER_KEY=... node verify/verify.mjs [--no-publish]
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import * as snarkjs from 'snarkjs'

const URL_ = process.env.CEREMONY_URL
const KEY = process.env.VERIFIER_KEY
const PUBLISH = !process.argv.includes('--no-publish')
const R1CS = 'circuit/transact.r1cs'
const PTAU = 'ptau/ppot_0080_16.ptau'
if (!URL_ || !KEY) throw new Error('set CEREMONY_URL and VERIFIER_KEY')
const auth = { authorization: `Bearer ${KEY}` }
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })

/** Runs the full snarkjs check and returns the contribution hashes it reports, oldest first. */
async function check(file) {
  const lines = []
  const log = (m) => lines.push(String(m))
  const logger = { info: log, warn: log, error: log, debug: () => {} }
  const ok = await snarkjs.zKey.verifyFromR1cs(R1CS, PTAU, file, logger)
  const found = []
  for (const l of lines) {
    const m = l.match(/^contribution #(\d+) ?(.*):\n([\s\S]+)$/)
    if (m) found[Number(m[1]) - 1] = { name: m[2], hash: m[3].replace(/\s+/g, '') }
  }
  return { ok, found, log: lines }
}

async function verdict(body) {
  const r = await fetch(`${URL_}/verdict`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`verdict failed: ${r.status} ${await r.text()}`)
}

for (let round = 0; round < 20; round++) {
  const res = await fetch(`${URL_}/pending`, { headers: auth })
  if (res.status === 204) {
    console.log('nothing waiting')
    break
  }
  if (!res.ok) throw new Error(`pending: ${res.status}`)
  const n = Number(res.headers.get('x-n'))
  const name = decodeURIComponent(res.headers.get('x-name') || '')
  const claimed = res.headers.get('x-claimed') || ''
  const file = `contribution_${String(n).padStart(4, '0')}.zkey`
  writeFileSync(file, new Uint8Array(await res.arrayBuffer()))
  console.log(`checking contribution #${n} from "${name}"`)

  const state = await (await fetch(`${URL_}/state`)).json()
  const accepted = state.contributions.map((c) => c.hash)
  const { ok, found, log } = await check(file).catch((e) => ({ ok: false, found: [], log: [String(e?.message || e)] }))
  console.log(log.join('\n'))

  let reason = ''
  if (!ok) reason = 'snarkjs rejected the key'
  else if (found.length !== n) reason = `expected ${n} contributions, found ${found.length}`
  else if (accepted.some((h, i) => found[i]?.hash !== h)) reason = 'it does not build on the accepted transcript'
  else if (accepted.length !== n - 1) reason = 'the transcript moved on'
  else if (!/^[0-9a-f]{128}$/.test(found[n - 1].hash)) reason = 'no hash for the new contribution'

  if (reason) {
    console.log(`REJECTED #${n}: ${reason}`)
    await verdict({ n, ok: false, reason })
    continue
  }
  const hash = found[n - 1].hash
  console.log(`ACCEPTED #${n}: ${hash}${claimed && claimed !== hash ? ' (differs from what the browser showed)' : ''}`)

  if (PUBLISH) {
    // archive first, so every accepted key is public before it becomes "latest"
    sh('gh', ['release', 'upload', 'contributions', file, '--clobber'])
    if (!existsSync('TRANSCRIPT.md')) writeFileSync('TRANSCRIPT.md', '# Transcript\n\n| # | Contributor | Contribution hash | Time (UTC) |\n|---|---|---|---|\n')
    const safe = name.replace(/[|`<>\[\]]/g, '')
    if (!readFileSync('TRANSCRIPT.md', 'utf8').includes(`| ${n} |`)) appendFileSync('TRANSCRIPT.md', `| ${n} | ${safe} | \`${hash}\` | ${new Date().toISOString().slice(0, 16).replace('T', ' ')} |\n`)
    sh('git', ['add', 'TRANSCRIPT.md'])
    sh('git', ['commit', '-m', `Contribution #${n} verified`])
    sh('git', ['push'])
  }
  await verdict({ n, ok: true, hash })
}
process.exit(0)
