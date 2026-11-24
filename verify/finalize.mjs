// Closes the ceremony. A public random number from drand (League of Entropy),
// at a round announced in advance, is mixed into the last accepted key, so the
// final key also depends on something nobody could know or choose beforehand.
//
//   node verify/finalize.mjs <last-accepted.zkey> <drand round>
//   -> final/transact_final.zkey, final/transact_vkey.json, final/TransactVerifier.sol
import { mkdirSync, writeFileSync } from 'node:fs'
import * as snarkjs from 'snarkjs'

const [input, round] = process.argv.slice(2)
if (!input || !/^\d+$/.test(round || '')) throw new Error('usage: node verify/finalize.mjs <last-accepted.zkey> <drand round>')

// drand mainnet (default chain); the round's randomness is the same for everyone, forever
const beacon = await (await fetch(`https://api.drand.sh/public/${round}`)).json()
if (!/^[0-9a-f]{64}$/.test(beacon.randomness || '')) throw new Error(`drand round ${round} is not available yet`)
console.log(`drand round ${round}: ${beacon.randomness}`)

mkdirSync('final', { recursive: true })
const out = 'final/transact_final.zkey'
const log = { info: console.log, warn: console.log, error: console.log, debug: () => {} }
await snarkjs.zKey.beacon(input, out, `drand round ${round}`, beacon.randomness, 10, log)
if (!(await snarkjs.zKey.verifyFromR1cs('circuit/transact.r1cs', 'ptau/ppot_0080_16.ptau', out, log))) throw new Error('final key failed verification')

writeFileSync('final/transact_vkey.json', JSON.stringify(await snarkjs.zKey.exportVerificationKey(out), null, 1))
const templates = { groth16: (await import('node:fs')).readFileSync(new URL('../node_modules/snarkjs/templates/verifier_groth16.sol.ejs', import.meta.url), 'utf8') }
writeFileSync('final/TransactVerifier.sol', await snarkjs.zKey.exportSolidityVerifier(out, templates))
console.log('final key, verification key and verifier written to final/')
process.exit(0)
