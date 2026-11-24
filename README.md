# Furtive setup ceremony

Every private trade on [Furtive](https://furtive.app) is checked against a proving key for the `transact` circuit. A Groth16 key has to be made once, and whoever made it alone could fake proofs. So it is made in public instead: many people each add their own randomness and throw it away. As long as one of them was honest, nobody can fake a proof, including the Furtive team.

**Take part:** [furtive.app/ceremony](https://furtive.app/ceremony). It runs in your browser and takes about a minute.

## How it works

1. **Phase 1** is the public [Perpetual Powers of Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau), file `ppot_0080_16.ptau` (80 contributions), downloaded from the official source and checked by its SHA-256:
   `ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9`
2. **Phase 2** is this ceremony, for Furtive's circuit only. It starts from the key anyone can rebuild with `snarkjs groth16 setup circuit/transact.r1cs ppot_0080_16.ptau start.zkey`.
3. Contributors take turns through a small coordinator. Each one downloads the latest key, adds randomness in their browser and uploads the new key. The randomness never leaves their browser.
4. Every upload is checked from scratch by [`verify/verify.mjs`](verify/verify.mjs), running in this repository's [GitHub Actions](../../actions), before anyone builds on it. It must pass `snarkjs` verification, keep every earlier contribution and add exactly one. Accepted keys are published under [Releases](../../releases/tag/contributions) and listed in [TRANSCRIPT.md](TRANSCRIPT.md).
5. To close, a [drand](https://drand.love) random number from a round announced in advance is mixed in with [`verify/finalize.mjs`](verify/finalize.mjs). The result is the final key and the verifier contract the Furtive vault uses.

## Check it yourself

```
npm install
curl -L -o ppot_0080_16.ptau https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_16.ptau
npx snarkjs zkey verify circuit/transact.r1cs ppot_0080_16.ptau <any published .zkey>
```

It prints every contribution's hash. Find yours (the page shows it when you finish), and check the circuit hash matches the circuit in [furtive-protocol](https://github.com/furtiveapp/furtive-protocol).

## The circuit

`circuit/transact.r1cs` is compiled from [`circuits/src/transact.circom`](https://github.com/furtiveapp/furtive-protocol/tree/main/circuits) with circom 2.2.2 (`circom src/transact.circom --O2 --r1cs`). SHA-256:
`d5ff1393a7f7ca025c67d839891de31ac4e3c7de808ea110fdfcc2f0eabe074e`

## Licence

GPL-3.0.
