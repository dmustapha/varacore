/**
 * deploy-testnet.mjs — Deploy varacore (with SEC-001 fix) to testnet
 * Uses: target/wasm32-unknown-unknown/wasm32-gear/release/varacore.wasm
 * (gear-processed intermediate, not the .opt.wasm — confirmed to pass gas estimation)
 */
import { GearApi, GearKeyring } from '@gear-js/api';
import { u8aToHex } from '@polkadot/util';
import { decodeAddress } from '@polkadot/util-crypto';
import { readFileSync } from 'fs';

const ENDPOINT = 'wss://testnet.vara.network';
const INIT_PAYLOAD = '0x0c4e6577'; // compact(3) + "New"
const WASM_PATH = '/Users/MAC/vara-a2a/target/wasm32-unknown-unknown/wasm32-gear/release/varacore.wasm';

async function main() {
  console.log('Connecting to testnet...');
  const api = await GearApi.create({ providerAddress: ENDPOINT });
  const alice = await GearKeyring.fromSuri('//Alice');
  const aliceHex = u8aToHex(decodeAddress(alice.address));
  console.log(`Connected: ${(await api.rpc.system.chain()).toString()}`);
  console.log(`Alice: ${alice.address}`);

  const code = readFileSync(WASM_PATH);
  console.log(`WASM: ${code.length} bytes — ${WASM_PATH.split('/').pop()}`);

  // Estimate gas
  console.log('\nEstimating gas...');
  const gas = await api.program.calculateGas.initUpload(aliceHex, code, INIT_PAYLOAD, 0, true);
  const gasLimit = gas.min_limit.toBigInt() * 2n;
  console.log(`min_limit: ${gas.min_limit.toString()} → gasLimit: ${gasLimit}`);

  // Upload program
  const { extrinsic, programId, codeId } = api.program.upload({
    code,
    initPayload: INIT_PAYLOAD,
    gasLimit,
  });
  console.log(`\nPredicted programId: ${programId}`);
  console.log(`codeId: ${codeId}`);
  console.log('Submitting upload...');

  await new Promise((resolve, reject) => {
    extrinsic.signAndSend(alice, ({ status, events, dispatchError }) => {
      console.log(`  Status: ${status.type}`);
      if (status.isInBlock || status.isFinalized) {
        const block = (status.isInBlock ? status.asInBlock : status.asFinalized).toHex();
        for (const { event } of events) {
          const name = `${event.section}.${event.method}`;
          const skip = ['balances.Withdraw','balances.Deposit','treasury.Deposit','transactionPayment.TransactionFeePaid'];
          if (!skip.includes(name)) {
            console.log(`  ${name}: ${JSON.stringify(event.data.toJSON())}`);
          }
          if (name === 'system.ExtrinsicSuccess') resolve({ programId, codeId, block });
          if (name === 'system.ExtrinsicFailed') {
            reject(new Error('ExtrinsicFailed: ' + JSON.stringify(event.data.toJSON()?.[0])));
          }
        }
        if (dispatchError) reject(new Error('DispatchError: ' + dispatchError.toString()));
      }
    }).catch(reject);
  });

  await api.disconnect();

  console.log('\n✓ DEPLOYMENT COMPLETE');
  console.log(`New VARACORE_PROGRAM_ID (testnet): ${programId}`);
  console.log('\nNext steps:');
  console.log(`1. agent/.env → VARACORE_PROGRAM_ID=${programId}`);
  console.log(`2. wire-auth-test.mjs → PROGRAM_ID = '${programId}'`);
  console.log('3. node wire-auth-test.mjs');

  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
setTimeout(() => { console.error('timeout'); process.exit(1); }, 180000);
