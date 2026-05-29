const { GearApi, GearKeyring } = require('@gear-js/api');
const { decodeAddress } = require('@polkadot/util-crypto');
const { u8aToHex } = require('@polkadot/util');

const PROGRAM_ID = '0x1f605827629395edfb02ffea469bac6e9a44fdd1a1d110700d7504e6157c33d9';

function scaleEncodeString(s) {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([bytes.length * 4]), bytes]);
}

GearApi.create({ providerAddress: 'wss://testnet.vara.network' }).then(async (api) => {
  await api.isReadyOrError;
  const keyring = await GearKeyring.fromSuri('//Alice');
  const source = u8aToHex(decodeAddress(keyring.address));
  
  const payload = '0x' + scaleEncodeString('Oracle').toString('hex') + scaleEncodeString('GetSupportedAssets').toString('hex');
  console.log('GetSupportedAssets payload:', payload);
  
  const gas = await api.program.calculateGas.handle(source, PROGRAM_ID, payload, 0, true);
  console.log('Gas estimate:', gas.min_limit.toHuman());
  
  const extrinsic = api.message.send({ destination: PROGRAM_ID, payload, gasLimit: gas.min_limit, value: 0 });
  
  let replyPayload = null;
  
  const unsub = await api.gearEvents.subscribeToGearEvent('UserMessageSent', (event) => {
    const { message } = event.data;
    if (message.source.toHex() === PROGRAM_ID) {
      replyPayload = message.payload.toHex();
      console.log('REPLY hex:', replyPayload);
      unsub();
    }
  });
  
  await new Promise((resolve, reject) => {
    extrinsic.signAndSend(keyring, ({ status, events, dispatchError }) => {
      if (status.isInBlock || status.isFinalized) {
        for (const { event } of events) {
          const name = event.section + '.' + event.method;
          if (name === 'system.ExtrinsicFailed') reject(new Error('ExtrinsicFailed'));
          if (name === 'system.ExtrinsicSuccess') resolve(null);
        }
        if (dispatchError) reject(new Error(dispatchError.toString()));
      }
    });
  });
  
  // Wait for reply (up to 15s for block processing)
  let waited = 0;
  while (!replyPayload && waited < 15000) {
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
  }
  
  if (replyPayload) {
    console.log('Got reply from VaraCore Oracle!');
    console.log('Raw reply:', replyPayload);
  } else {
    console.log('No reply received within 15s');
  }
  
  await api.disconnect();
  process.exit(0);
}).catch(e => { console.error('ERR:', e.message.slice(0,200)); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 60000);
