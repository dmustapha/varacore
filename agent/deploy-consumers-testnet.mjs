/**
 * deploy-consumers-testnet.mjs — Deploy SEC-003-fixed consumer programs to testnet
 * Deploys price-consumer and agent-consumer with owner-gated address setters.
 * After deploy, configures each consumer to point at varacore testnet.
 */
import { GearApi, GearKeyring } from '@gear-js/api';
import { u8aToHex } from '@polkadot/util';
import { decodeAddress } from '@polkadot/util-crypto';
import { readFileSync } from 'fs';

const ENDPOINT = 'wss://testnet.vara.network';
const VARACORE_TESTNET_ID = '0xa9d1ab8bfb11a571059ac5f77713fcb077522789886eeffa200d3851c1c01439';
const INIT_PAYLOAD = '0x0c4e6577'; // compact(3) + "New"

const PRICE_CONSUMER_WASM = '/Users/MAC/vara-a2a/target/wasm32-unknown-unknown/wasm32-gear/release/price_consumer.wasm';
const AGENT_CONSUMER_WASM = '/Users/MAC/vara-a2a/target/wasm32-unknown-unknown/wasm32-gear/release/agent_consumer.wasm';

function scaleString(s) {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([bytes.length * 4]), bytes]);
}
function scaleActorId(hex) {
  return Buffer.from(hex.replace('0x', ''), 'hex');
}

async function deployProgram(api, alice, aliceHex, code, label) {
  console.log(`\nDeploying ${label} (${code.length} bytes)...`);
  const gas = await api.program.calculateGas.initUpload(aliceHex, code, INIT_PAYLOAD, 0, true);
  const gasLimit = gas.min_limit.toBigInt() * 2n;
  console.log(`  gas min_limit: ${gas.min_limit.toString()} → using: ${gasLimit}`);

  const { extrinsic, programId, codeId } = api.program.upload({
    code,
    initPayload: INIT_PAYLOAD,
    gasLimit,
  });
  console.log(`  predicted programId: ${programId}`);

  await new Promise((resolve, reject) => {
    extrinsic.signAndSend(alice, ({ status, events, dispatchError }) => {
      console.log(`  status: ${status.type}`);
      if (status.isInBlock || status.isFinalized) {
        for (const { event } of events) {
          const name = `${event.section}.${event.method}`;
          const skip = ['balances.Withdraw','balances.Deposit','treasury.Deposit','transactionPayment.TransactionFeePaid'];
          if (!skip.includes(name)) console.log(`  ${name}: ${JSON.stringify(event.data.toJSON())}`);
          if (name === 'system.ExtrinsicSuccess') resolve();
          if (name === 'system.ExtrinsicFailed') reject(new Error('ExtrinsicFailed: ' + JSON.stringify(event.data.toJSON()?.[0])));
        }
        if (dispatchError) reject(new Error('DispatchError: ' + dispatchError.toString()));
      }
    }).catch(reject);
  });

  console.log(`  ${label} deployed: ${programId}`);
  return programId;
}

async function callSetter(api, alice, programId, serviceName, methodName, actorIdHex, label) {
  const source = u8aToHex(decodeAddress(alice.address));
  const payload = Buffer.concat([
    scaleString(serviceName),
    scaleString(methodName),
    scaleActorId(actorIdHex),
  ]);
  const payloadHex = '0x' + payload.toString('hex');

  console.log(`\nCalling ${serviceName}.${methodName} on ${programId.slice(0, 10)}...`);
  const gas = await api.program.calculateGas.handle(source, programId, payloadHex, 0, true);

  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true }); } }, 25000);

    api.gearEvents.subscribeToGearEvent('UserMessageSent', (event) => {
      const { message } = event.data;
      if (!done && message.source.toHex() === programId) {
        done = true;
        clearTimeout(timer);
        resolve({ replyHex: message.payload.toHex() });
      }
    }).then(() => {
      api.message.send({
        destination: programId,
        payload: payloadHex,
        gasLimit: gas.min_limit.toBigInt() * 2n,
        value: 0n,
      }).signAndSend(alice, ({ status }) => {
        if (status.isInBlock) console.log(`  ${label}: InBlock`);
      }).catch(reject);
    }).catch(reject);
  });
}

async function main() {
  console.log('Connecting to testnet...');
  const api = await GearApi.create({ providerAddress: ENDPOINT });
  const alice = await GearKeyring.fromSuri('//Alice');
  const aliceHex = u8aToHex(decodeAddress(alice.address));
  console.log(`Chain: ${(await api.rpc.system.chain()).toString()}`);
  console.log(`Alice: ${alice.address}`);
  console.log(`VaraCore testnet: ${VARACORE_TESTNET_ID}`);

  const priceConsumerCode = readFileSync(PRICE_CONSUMER_WASM);
  const agentConsumerCode = readFileSync(AGENT_CONSUMER_WASM);

  // Deploy both consumers
  const priceConsumerId = await deployProgram(api, alice, aliceHex, priceConsumerCode, 'price-consumer');
  const agentConsumerId = await deployProgram(api, alice, aliceHex, agentConsumerCode, 'agent-consumer');

  // Small delay to let blocks settle
  await new Promise(r => setTimeout(r, 3000));

  // Configure price-consumer → point at varacore testnet
  const r1 = await callSetter(api, alice, priceConsumerId, 'PriceConsumer', 'SetOracleAddress', VARACORE_TESTNET_ID, 'set_oracle_address');
  if (r1.timedOut) console.log('  set_oracle_address: TIMEOUT');
  else console.log(`  set_oracle_address reply: ${r1.replyHex}`);

  await new Promise(r => setTimeout(r, 3000));

  // Configure agent-consumer → point at varacore testnet
  const r2 = await callSetter(api, alice, agentConsumerId, 'AgentConsumer', 'SetVaracoreAddress', VARACORE_TESTNET_ID, 'set_varacore_address');
  if (r2.timedOut) console.log('  set_varacore_address: TIMEOUT');
  else console.log(`  set_varacore_address reply: ${r2.replyHex}`);

  await api.disconnect();

  console.log('\n=== DEPLOYMENT COMPLETE ===');
  console.log(`price-consumer testnet:  ${priceConsumerId}`);
  console.log(`agent-consumer testnet:  ${agentConsumerId}`);
  console.log('\nNext: update agent/.env with these testnet consumer IDs');

  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 300000);
