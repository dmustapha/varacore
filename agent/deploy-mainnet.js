// deploy-mainnet.js — Deploy VaraCore to Vara mainnet
const { GearApi, GearKeyring } = require('@gear-js/api');
const { decodeAddress } = require('@polkadot/util-crypto');
const { u8aToHex } = require('@polkadot/util');
const fs = require('fs');

const ENDPOINT = 'wss://rpc.vara-network.io';
const WASM_PATH = '../target/wasm32-gear/release/varacore.opt.wasm';
const SEED = process.env.MAINNET_SEED || '//Alice';

async function main() {
  console.log('Connecting to MAINNET:', ENDPOINT);
  const api = await GearApi.create({ providerAddress: ENDPOINT });
  await api.isReadyOrError;
  console.log('Connected. Chain:', (await api.rpc.system.chain()).toString());

  const code = fs.readFileSync(WASM_PATH);
  console.log('WASM size:', code.length, 'bytes');

  const keyring = await GearKeyring.fromSuri(SEED);
  console.log('Deployer:', keyring.address);
  const source = u8aToHex(decodeAddress(keyring.address));

  // Check balance
  const { data: balance } = await api.query.system.account(keyring.address);
  console.log('Balance:', balance.free.toHuman());

  console.log('Estimating gas...');
  const gas = await api.program.calculateGas.initUpload(source, code, '0x0c4e6577', 0, true);
  console.log('Gas estimate:', gas.min_limit.toHuman());

  const gasLimit = gas.min_limit.toBigInt() * 2n;
  const { extrinsic, programId } = api.program.upload({ code, initPayload: '0x0c4e6577', gasLimit });
  console.log('Expected program ID:', programId);

  const result = await new Promise((resolve, reject) => {
    extrinsic.signAndSend(keyring, ({ status, events, dispatchError }) => {
      console.log('Status:', status.type);
      if (status.isInBlock || status.isFinalized) {
        const block = (status.isInBlock ? status.asInBlock : status.asFinalized).toHex();
        for (const { event } of events) {
          const name = event.section + '.' + event.method;
          if (['gear.ProgramChanged','system.ExtrinsicSuccess','system.ExtrinsicFailed'].includes(name)) {
            console.log(name, JSON.stringify(event.data.toJSON()).slice(0, 120));
          }
        }
        if (dispatchError) reject(new Error(dispatchError.toString()));
        else resolve({ programId, block });
      }
    });
  });

  console.log('\n MAINNET DEPLOYED!');
  console.log('Program ID:', result.programId);
  console.log('Block:', result.block);
  await api.disconnect();
}

main().catch(e => { console.error('FAILED:', e.message.slice(0, 200)); process.exit(1); });
