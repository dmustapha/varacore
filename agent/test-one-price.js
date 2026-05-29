// One-shot price submission test
require('dotenv/config');
const { GearApi, GearKeyring } = require('@gear-js/api');

const PROGRAM_ID = process.env.VARACORE_PROGRAM_ID;
const ENDPOINT = process.env.VARA_ENDPOINT || 'wss://testnet.vara.network';

function scaleEncodeString(s) {
  const bytes = Buffer.from(s, 'utf8');
  // compact length encoding: len << 2 for single-byte (len < 64)
  return Buffer.concat([Buffer.from([bytes.length * 4]), bytes]);
}
function encodeBigIntU128(n) {
  const buf = Buffer.alloc(16);
  let low = n & 0xFFFFFFFFFFFFFFFFn;
  let high = n >> 64n;
  buf.writeBigUInt64LE(low, 0);
  buf.writeBigUInt64LE(high, 8);
  return [...buf];
}
function encodeBigIntU64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return [...buf];
}
function encodeU32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n, 0);
  return [...buf];
}

async function main() {
  console.log('Connecting to', ENDPOINT);
  const api = await GearApi.create({ providerAddress: ENDPOINT });
  await api.isReadyOrError;
  
  // Use fromSuri for dev account  
  const account = await GearKeyring.fromSuri('//Alice');
  console.log('Account:', account.address);
  
  // Build UpdatePrice payload for BTC/USD = $105,000
  const price = BigInt(105000 * 1e8); // $105,000 with 8 decimal places
  const confidence = BigInt(500 * 1e8); // ±$500
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const sourceCount = 2;
  
  const payload = '0x' + Buffer.from([
    ...scaleEncodeString('Oracle'),
    ...scaleEncodeString('UpdatePrice'),
    ...scaleEncodeString('BTC/USD'),
    ...encodeBigIntU128(price),
    ...encodeBigIntU128(confidence),
    ...encodeBigIntU64(timestamp),
    ...encodeU32(sourceCount),
  ]).toString('hex');
  
  console.log('UpdatePrice payload:', payload.slice(0, 80) + '...');
  
  // Calculate gas
  const { decodeAddress } = require('@polkadot/util-crypto');
  const { u8aToHex } = require('@polkadot/util');
  const source = u8aToHex(decodeAddress(account.address));
  
  const gas = await api.program.calculateGas.handle(source, PROGRAM_ID, payload, 0, true);
  console.log('Gas estimate:', gas.min_limit.toHuman());
  
  // Send UpdatePrice
  await new Promise((resolve, reject) => {
    api.message.send({
      destination: PROGRAM_ID,
      payload,
      gasLimit: gas.min_limit.toBigInt() * 2n,
      value: 0n,
    }).signAndSend(account, ({ status, events }) => {
      console.log('Status:', status.type);
      if (status.isInBlock || status.isFinalized) {
        for (const { event } of events) {
          const name = event.section + '.' + event.method;
          if (['system.ExtrinsicSuccess','system.ExtrinsicFailed','gear.UserMessageSent'].includes(name)) {
            console.log(name, JSON.stringify(event.data.toJSON()).slice(0, 150));
          }
        }
        const failed = events.some(({event}) => event.section === 'system' && event.method === 'ExtrinsicFailed');
        if (failed) reject(new Error('ExtrinsicFailed'));
        else resolve(null);
      }
    });
  });
  
  console.log('BTC/USD price update SUBMITTED!');
  
  // Wait for processing then verify
  await new Promise(r => setTimeout(r, 8000));
  
  // Query GetPrice BTC/USD
  const queryPayload = '0x' + Buffer.from([
    ...scaleEncodeString('Oracle'),
    ...scaleEncodeString('GetPrice'),
    ...scaleEncodeString('BTC/USD'),
  ]).toString('hex');
  
  const gas2 = await api.program.calculateGas.handle(source, PROGRAM_ID, queryPayload, 0, true);
  const extrinsic2 = api.message.send({ destination: PROGRAM_ID, payload: queryPayload, gasLimit: gas2.min_limit, value: 0 });
  
  let replyHex = null;
  const unsub = await api.gearEvents.subscribeToGearEvent('UserMessageSent', (event) => {
    const { message } = event.data;
    if (message.source.toHex() === PROGRAM_ID) {
      replyHex = message.payload.toHex();
      unsub();
    }
  });
  
  await new Promise((resolve, reject) => {
    extrinsic2.signAndSend(account, ({ status, events }) => {
      if (status.isInBlock || status.isFinalized) {
        const failed = events.some(({event}) => event.section === 'system' && event.method === 'ExtrinsicFailed');
        if (failed) reject(new Error('Query failed'));
        else resolve(null);
      }
    });
  });
  
  // Wait for reply
  let w = 0;
  while (!replyHex && w < 15000) { await new Promise(r => setTimeout(r, 500)); w += 500; }
  
  if (replyHex) {
    console.log('GetPrice reply hex:', replyHex.slice(0, 100) + '...');
    console.log('SUCCESS: Oracle returned price data!');
  } else {
    console.log('No reply received');
  }
  
  await api.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('FAILED:', e.message.slice(0,200)); process.exit(1); });
