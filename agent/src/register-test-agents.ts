// File: agent/src/register-test-agents.ts
// Pre-registers demo agents in AgentRegistryService before demo.
// Run against mainnet: VARA_ENDPOINT=wss://rpc.vara.network VARACORE_PROGRAM_ID=$MAINNET_ID npx ts-node src/register-test-agents.ts
import 'dotenv/config';
import { GearApi, GearKeyring } from '@gear-js/api';

const VARA_ENDPOINT = process.env.VARA_ENDPOINT || 'wss://rpc.vara-network.io';
const VARACORE_PROGRAM_ID = process.env.VARACORE_PROGRAM_ID!;
const MNEMONIC = process.env.PRICE_AGENT_MNEMONIC!;

const REGISTRATIONS = [
  {
    programId: process.env.PRICE_CONSUMER_PROGRAM_ID!,
    hubHandle: 'price-consumer-demo',
    capabilities: ['defi-consumer', 'price-feed-user', 'oracle-caller'],
    serviceType: 'DeFi',
    description: 'Demonstration program that calls VaraCore OracleService.GetPrice',
    endpointHint: 'https://agents.vara.network/catalog/price-consumer-demo',
  },
  {
    programId: process.env.AGENT_CONSUMER_PROGRAM_ID!,
    hubHandle: 'agent-consumer-demo',
    capabilities: ['reputation-consumer', 'discovery-consumer', 'trust-checker'],
    serviceType: 'Agent',
    description: 'Demonstration program that calls VaraCore ReputationService + AgentRegistryService',
    endpointHint: 'https://agents.vara.network/catalog/agent-consumer-demo',
  },
  {
    programId: '0x' + 'bb'.repeat(32),
    hubHandle: 'mock-defi-vault',
    capabilities: ['lending', 'collateral-management', 'price-feed-user'],
    serviceType: 'DeFi',
    description: 'Mock DeFi lending vault that consumes oracle prices for collateral valuation',
    endpointHint: 'N/A (mock agent for demo)',
  },
];

async function main() {
  const api = await GearApi.create({ providerAddress: VARA_ENDPOINT });
  const account = await GearKeyring.fromMnemonic(MNEMONIC);

  console.log('[register-test-agents] Starting...');

  for (const reg of REGISTRATIONS) {
    const payload = buildRegisterAgentPayload(reg);

    try {
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
            if (hasError) reject(new Error(`RegisterAgent failed for ${reg.hubHandle}`));
            else resolve();
          }
        })
        .catch(reject);
      });
      console.log(`  ✓ Registered: ${reg.hubHandle}`);
    } catch (e) {
      console.error(`  ✗ Failed ${reg.hubHandle}: ${e}`);
    }
  }

  console.log('[register-test-agents] Done.');
  await api.disconnect();
}

// SCALE compact-encode a string
function scaleEncodeString(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  const len = bytes.length;
  if (len < 64) return [(len << 2) & 0xff, ...bytes];
  return [(((len << 2) | 1) & 0xff), ((len >> 6) & 0xff), ...bytes];
}

// SCALE compact-encode a u32 count prefix for a Vec
function scaleCompactU32(n: number): number[] {
  if (n < 64) return [(n << 2) & 0xff];
  return [(((n << 2) | 1) & 0xff), ((n >> 6) & 0xff)];
}

// ServiceType enum variant indices (must match registry.rs order)
const SERVICE_TYPE_INDEX: Record<string, number> = {
  Oracle: 0, Reputation: 1, Registry: 2, DeFi: 3, Social: 4, Agent: 5, Other: 6,
};

function buildRegisterAgentPayload(reg: typeof REGISTRATIONS[0]): `0x${string}` {
  // SCALE payload: ("Registry", "RegisterAgent", AgentRegistration)
  // IDL: RegisterAgent(registration: AgentRegistration) -> result(null, str)
  // AgentRegistration = { hub_handle: str, capabilities: vec str, service_type: ServiceType, description: str, endpoint_hint: str }
  const serviceBytes    = scaleEncodeString('Registry');
  const methodBytes     = scaleEncodeString('RegisterAgent');
  const hubHandleBytes  = scaleEncodeString(reg.hubHandle);
  // Vec<String>: compact(count) + each SCALE string
  const capCountBytes   = scaleCompactU32(reg.capabilities.length);
  const capBytes        = reg.capabilities.flatMap(c => scaleEncodeString(c));
  const serviceTypeByte = [SERVICE_TYPE_INDEX[reg.serviceType] ?? 6];
  const descBytes       = scaleEncodeString(reg.description);
  const endpointBytes   = scaleEncodeString(reg.endpointHint);

  const combined = new Uint8Array([
    ...serviceBytes, ...methodBytes,
    ...hubHandleBytes, ...capCountBytes, ...capBytes,
    ...serviceTypeByte, ...descBytes, ...endpointBytes,
  ]);
  return `0x${Buffer.from(combined).toString('hex')}`;
}

main().catch(console.error);
