// deploy-v3.ts — Deploy VaraCore v3 + companions to Vara mainnet
import 'dotenv/config';
import { readFileSync } from 'fs';
import { GearApi, GearKeyring } from '@gear-js/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { u8aToHex } from '@polkadot/util';

const ENDPOINT = 'wss://rpc.vara.network';
const WALLET_PATH = '/Users/MAC/.vara-wallet/wallets/varacore-operator.json';
// gear-wasm-builder output (processed for Gear runtime) — NOT the raw wasm32-unknown-unknown output
const BASE = '/Users/MAC/vara-a2a/target/wasm32-unknown-unknown/wasm-projects/release/wasm32v1-none/release';

// Sails constructor payload: SCALE-encoded string "New" (compact(3) + "New")
const INIT_PAYLOAD: `0x${string}` = '0x0c4e6577';

async function uploadProgram(
  api: GearApi,
  account: KeyringPair,
  wasmPath: string,
  label: string
): Promise<string> {
  const code = readFileSync(wasmPath);
  const sourceHex = u8aToHex(account.addressRaw);

  console.log(`\n[deploy] Calculating gas for ${label} (${code.length} bytes)...`);
  let gasLimit: bigint;
  try {
    const gas = await api.program.calculateGas.initUpload(
      sourceHex,
      code,
      INIT_PAYLOAD,
      0,
      true
    );
    gasLimit = gas.min_limit.toBigInt() * 11n / 10n; // +10% headroom
    console.log(`[deploy] Gas estimate: ${gasLimit.toLocaleString()}`);
  } catch (e: any) {
    gasLimit = 750_000_000_000n; // chain max if estimation fails
    console.log(`[deploy] Gas estimate failed (${e.message}), using chain max`);
  }

  const { programId, extrinsic } = api.program.upload({
    code,
    initPayload: INIT_PAYLOAD,
    gasLimit,
    value: 0,
  });

  console.log(`[deploy] Expected programId: ${programId}`);

  return new Promise((resolve, reject) => {
    extrinsic.signAndSend(account, ({ status, events }: any) => {
      if (status.isInBlock) {
        console.log(`[deploy] ${label} in block: ${status.asInBlock.toHex()}`);
      }
      if (status.isFinalized) {
        const failed = events.some((e: any) =>
          api.events.system.ExtrinsicFailed.is(e.event)
        );
        const allEvents = events.map((e: any) => `${e.event.section}.${e.event.method}`).join(', ');
        if (failed) {
          reject(new Error(`${label} deploy failed on-chain. Events: ${allEvents}`));
        } else {
          console.log(`[deploy] ✅ ${label} finalized. Events: ${allEvents}`);
          resolve(programId);
        }
      }
    }).catch(reject);
  });
}

async function main() {
  console.log('[deploy] Connecting to Vara mainnet...');
  const api = await GearApi.create({ providerAddress: ENDPOINT });
  console.log('[deploy] Connected');

  const keystoreJson = readFileSync(WALLET_PATH, 'utf8');
  const account = GearKeyring.fromJson(keystoreJson, '');
  console.log(`[deploy] Account: ${account.address}`);

  const target = process.argv[2] || 'all';

  if (target === 'varacore' || target === 'all') {
    const pid = await uploadProgram(api, account, `${BASE}/varacore.wasm`, 'VaraCore');
    console.log(`VARACORE_V3_PID=${pid}`);
  }

  if (target === 'price_consumer' || target === 'all') {
    const pid = await uploadProgram(api, account, `${BASE}/price_consumer.wasm`, 'PriceConsumer');
    console.log(`PRICE_CONSUMER_V3_PID=${pid}`);
  }

  if (target === 'agent_consumer' || target === 'all') {
    const pid = await uploadProgram(api, account, `${BASE}/agent_consumer.wasm`, 'AgentConsumer');
    console.log(`AGENT_CONSUMER_V3_PID=${pid}`);
  }

  await api.disconnect();
  console.log('\n[deploy] Done.');
}

main().catch(e => { console.error('[deploy] Fatal:', e.message); process.exit(1); });
