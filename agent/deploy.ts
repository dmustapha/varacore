// deploy.ts — Deploy VaraCore using @gear-js/api for precise control over gas estimation
import 'dotenv/config';
import fs from 'fs';
import { GearApi, GearKeyring } from '@gear-js/api';
import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';

const ENDPOINT = process.env.VARA_ENDPOINT || 'wss://testnet.vara.network';
const WASM_PATH = '../target/wasm32-unknown-unknown/release/varacore.wasm';
const ALICE_MNEMONIC = process.env.AGENT_SEED || '//Alice';

async function main() {
  console.log('Connecting to', ENDPOINT);
  const api = await GearApi.create({ providerAddress: ENDPOINT });
  await api.isReadyOrError;
  console.log('Connected. Chain:', (await api.rpc.system.chain()).toString());

  // Load WASM
  const code = fs.readFileSync(WASM_PATH);
  console.log('WASM size:', code.length, 'bytes');

  // Keyring
  const keyring = await GearKeyring.fromSuri(ALICE_MNEMONIC);
  console.log('Deployer (SS58):', keyring.address);

  // Convert SS58 address to H256 (raw 32-byte AccountId)
  const sourceH256 = u8aToHex(decodeAddress(keyring.address));
  console.log('Deployer (H256):', sourceH256);

  // Init payload: "New".encode() in SCALE = 0x0c4e6577
  const initPayload = '0x0c4e6577';

  // Estimate gas for upload
  console.log('Estimating gas...');
  const gas = await api.program.calculateGas.initUpload(
    sourceH256 as any,
    code,
    initPayload,
    0,
    true,
  );
  console.log('Gas estimate:', {
    min_limit: gas.min_limit.toHuman(),
    reserved: gas.reserved.toHuman(),
    burned: gas.burned.toHuman(),
  });

  const gasLimit = gas.min_limit.toBigInt() * 2n; // 2x safety margin
  console.log('Using gas limit:', gasLimit.toString());

  // Upload program
  const { extrinsic, programId, codeId } = api.program.upload({
    code,
    initPayload,
    gasLimit,
  });
  console.log('Program ID will be:', programId);

  const result = await new Promise<any>((resolve, reject) => {
    extrinsic.signAndSend(keyring, ({ status, events, dispatchError }) => {
      console.log('Status:', status.type);
      if (status.isInBlock || status.isFinalized) {
        const block = status.isInBlock ? status.asInBlock : status.asFinalized;
        console.log('Block:', block.toHex());

        for (const { event } of events) {
          const name = `${event.section}.${event.method}`;
          if (name === 'gear.MessageQueued') {
            console.log('MessageQueued:', event.data.toJSON());
          }
          if (name === 'gear.ProgramChanged') {
            console.log('ProgramChanged:', event.data.toJSON());
          }
          if (name === 'system.ExtrinsicSuccess') {
            console.log('ExtrinsicSuccess');
            resolve({ programId, codeId, block: block.toHex() });
          }
          if (name === 'system.ExtrinsicFailed') {
            const errData = (event.data as any)?.[0]?.toJSON?.() || event.data.toJSON();
            console.error('ExtrinsicFailed:', JSON.stringify(errData));
            reject(new Error('ExtrinsicFailed: ' + JSON.stringify(errData)));
          }
        }

        if (dispatchError) {
          reject(new Error('DispatchError: ' + dispatchError.toString()));
        }
      }
    });
  });

  console.log('\n✅ DEPLOYED!');
  console.log('Program ID:', result.programId);
  console.log('Block:', result.block);

  await api.disconnect();
}

main().catch(e => {
  console.error('Deploy failed:', e.message);
  process.exit(1);
});
