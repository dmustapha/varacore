// File: agent/src/seed-interactions.ts
// Pre-seeds ReputationService with synthetic interaction history before demo.
// Run against mainnet: VARA_ENDPOINT=wss://rpc.vara.network VARACORE_PROGRAM_ID=$MAINNET_ID npx ts-node src/seed-interactions.ts
import 'dotenv/config';
import { readFileSync } from 'fs';
import { GearApi, GearKeyring } from '@gear-js/api';

const VARA_ENDPOINT = process.env.VARA_ENDPOINT || 'wss://rpc.vara.network';
const VARACORE_PROGRAM_ID = process.env.VARACORE_PROGRAM_ID!;
const MNEMONIC = process.env.PRICE_AGENT_MNEMONIC!;

// Support mainnet consumer IDs (PRICE_CONSUMER_PROGRAM_ID) with fallback to suffixed variants
const PRICE_CONSUMER_ID = (
  process.env.PRICE_CONSUMER_PROGRAM_ID ||
  process.env.PRICE_CONSUMER_MAINNET_PROGRAM_ID
)!;
const AGENT_CONSUMER_ID = (
  process.env.AGENT_CONSUMER_PROGRAM_ID ||
  process.env.AGENT_CONSUMER_MAINNET_PROGRAM_ID
)!;

// Synthetic agents to seed
const MOCK_AGENTS = [
  PRICE_CONSUMER_ID,
  AGENT_CONSUMER_ID,
  '0x' + 'aa'.repeat(32),
];

const INTERACTIONS = [
  { success: true, context: 'GetPrice call returned fresh BTC data' },
  { success: true, context: 'GetPrice call returned fresh ETH data' },
  { success: true, context: 'DiscoverAgents returned 3 oracle agents' },
  { success: false, context: 'ScoreAgent call failed: agent not found' },
  { success: true, context: 'GetMultiplePrices successful for 5 assets' },
];

async function sendRecordInteraction(
  api: GearApi,
  account: any,
  agentId: string,
  success: boolean,
  context: string
): Promise<void> {
  const payload = buildRecordInteractionPayload(agentId, success, context);

  await new Promise<void>((resolve, reject) => {
    api.message.send({
      destination: VARACORE_PROGRAM_ID as `0x${string}`,
      payload,
      gasLimit: 5_000_000_000n,
      value: 0n,
    })
    .signAndSend(account, ({ status, events }: { status: any; events: any[] }) => {
      if (status.isFinalized) {
        const hasError = events.some((e: any) => api.events.system.ExtrinsicFailed.is(e.event));
        if (hasError) reject(new Error('RecordInteraction failed'));
        else resolve();
      }
    })
    .catch(reject);
  });
}

// SCALE compact-encode a string (len < 64 optimization covers all our use cases)
function scaleEncodeString(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  const len = bytes.length;
  if (len < 64) return [(len << 2) & 0xff, ...bytes];
  return [(((len << 2) | 1) & 0xff), ((len >> 6) & 0xff), ...bytes];
}

function scaleEncodeActorId(hexId: string): number[] {
  // ActorId is 32 raw bytes; strip 0x prefix
  const clean = hexId.startsWith('0x') ? hexId.slice(2) : hexId;
  const padded = clean.padStart(64, '0').slice(0, 64);
  const result: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    result.push(parseInt(padded.slice(i, i + 2), 16));
  }
  return result;
}

function buildRecordInteractionPayload(
  agentId: string, success: boolean, context: string
): `0x${string}` {
  // SCALE payload: ("Reputation", "RecordInteraction", agent_id, success, context)
  // IDL signature: RecordInteraction(agent_id: actor_id, success: bool, context: str) -> result(null, str)
  const serviceBytes = scaleEncodeString('Reputation');
  const methodBytes  = scaleEncodeString('RecordInteraction');
  const agentBytes   = scaleEncodeActorId(agentId);
  const successByte  = [success ? 0x01 : 0x00];
  const contextBytes = scaleEncodeString(context);

  const combined = new Uint8Array([
    ...serviceBytes, ...methodBytes, ...agentBytes, ...successByte, ...contextBytes,
  ]);
  return `0x${Buffer.from(combined).toString('hex')}`;
}

async function main() {
  const api = await GearApi.create({ providerAddress: VARA_ENDPOINT });
  // SEED-KEY FIX: support keystore JSON file path in MNEMONIC env var.
  // price-agent.ts has this check; seed-interactions.ts previously called
  // fromMnemonic unconditionally, throwing when PRICE_AGENT_MNEMONIC is a file path.
  const account = MNEMONIC.startsWith('/')
    ? GearKeyring.fromJson(JSON.parse(readFileSync(MNEMONIC, 'utf8')), undefined)
    : await GearKeyring.fromMnemonic(MNEMONIC);

  console.log('[seed-interactions] Starting...');

  for (const agentId of MOCK_AGENTS) {
    for (const { success, context } of INTERACTIONS) {
      try {
        await sendRecordInteraction(api, account, agentId, success, context);
        console.log(`  ✓ RecordInteraction(${agentId.slice(0, 10)}..., ${success}, "${context.slice(0, 30)}...")`);
      } catch (e) {
        console.error(`  ✗ Failed: ${e}`);
      }
    }
  }

  console.log('[seed-interactions] Done.');
  await api.disconnect();
}

main().catch(console.error);
