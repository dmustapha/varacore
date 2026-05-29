// File: agent/src/register-hub.ts
// [UNVERIFIED] — Hub Catalog registration exact payload format. Verify against live IDL Day 14.
// WARNING: UNVERIFIED PATTERN — adjust method names if Hub Registry IDL differs.
import 'dotenv/config';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { GearApi, GearKeyring } from '@gear-js/api';
import axios from 'axios';

// BUG-005 FIX: use mainnet vars — testnet PID caused integrationsIn=0 on Hub.
// Requires: VARA_MAINNET_ENDPOINT, VARACORE_MAINNET_PROGRAM_ID, PRICE_AGENT_MNEMONIC in .env
const VARA_ENDPOINT = process.env.VARA_MAINNET_ENDPOINT || 'wss://rpc.vara.network';
const BUILDER_MNEMONIC = process.env.PRICE_AGENT_MNEMONIC!;
const VARACORE_PROGRAM_ID = process.env.VARACORE_MAINNET_PROGRAM_ID!;

// Hub Registry program ID (confirmed from agent-onboarding.md)
const HUB_REGISTRY_PID = '0x19f27f4c906a5ac230be82d907850d44c7a7fff1b4c6903f62e78e09e0b353f3';

// Voucher backend for gas-free Hub writes
const VOUCHER_BACKEND = 'https://voucher-backend-agents.vara.network/voucher';

async function getVoucher(account: string): Promise<string> {
  const res = await axios.post(VOUCHER_BACKEND, {
    account,
    programId: HUB_REGISTRY_PID,
  });
  return res.data.voucherId;
}

function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function sendHubMessage(
  api: GearApi,
  account: any,
  payload: `0x${string}`
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    api.message.send({
      destination: HUB_REGISTRY_PID as `0x${string}`,
      payload,
      gasLimit: 50_000_000_000n,
      value: 0n,
    })
    .signAndSend(account, ({ status, events }: { status: any; events: any[] }) => {
      if (status.isFinalized) {
        const hasError = events.some((e: any) => api.events.system.ExtrinsicFailed.is(e.event));
        if (hasError) reject(new Error('Hub message failed'));
        else resolve();
      }
    })
    .catch(reject);
  });
}

async function main() {
  const step = process.argv[2]; // '1' or '2'

  const api = await GearApi.create({ providerAddress: VARA_ENDPOINT });
  const account = await GearKeyring.fromMnemonic(BUILDER_MNEMONIC);

  console.log(`[register-hub] Account: ${account.address}`);

  if (step === '1') {
    console.log('[register-hub] Step 1: RegisterParticipant');
    // [UNVERIFIED] — payload must match Hub Registry IDL RegisterParticipant method
    const payload = buildRegisterParticipantPayload('varacore-dev', 'https://github.com/dmustapha/varacore');
    await sendHubMessage(api, account, payload);
    console.log('[register-hub] RegisterParticipant sent. Check Hub Catalog for confirmation.');
  } else if (step === '2') {
    if (!VARACORE_PROGRAM_ID) throw new Error('VARACORE_PROGRAM_ID required for step 2');

    const idlPath = process.argv[3] || '../varacore/varacore.idl';
    const skillPath = process.argv[4] || 'SKILL.md';

    const idlHash = sha256File(idlPath);
    const skillsHash = sha256File(skillPath);

    console.log(`[register-hub] IDL hash: ${idlHash}`);
    console.log(`[register-hub] Skills hash: ${skillsHash}`);

    console.log('[register-hub] Step 2: RegisterApplication');
    const regPayload = buildRegisterApplicationPayload(
      VARACORE_PROGRAM_ID,
      'VaraCore',
      'Three-service agent trust infrastructure: Oracle + Reputation + Registry in one Sails program.',
      'https://github.com/dmustapha/varacore',
      'https://raw.githubusercontent.com/dmustapha/varacore/main/SKILL.md',
      skillsHash,
      'https://raw.githubusercontent.com/dmustapha/varacore/main/varacore.idl',
      idlHash,
      'Services'
    );
    await sendHubMessage(api, account, regPayload);
    console.log('[register-hub] RegisterApplication sent.');

    console.log('[register-hub] Step 2b: SubmitApplication');
    const submitPayload = buildSubmitApplicationPayload(VARACORE_PROGRAM_ID);
    await sendHubMessage(api, account, submitPayload);
    console.log('[register-hub] SubmitApplication sent. VaraCore should appear in Hub Catalog.');
  } else {
    console.log('Usage: ts-node register-hub.ts <1|2> [idl_path] [skill_path]');
  }

  await api.disconnect();
}

// [UNVERIFIED] — These payload builders produce SCALE-encoded Hub messages.
// The exact method names and arg layouts MUST match the Hub Registry IDL.
// Check Hub Registry IDL at: https://agents.vara.network before running.

function buildRegisterParticipantPayload(handle: string, github: string): `0x${string}` {
  // Placeholder — replace with sails-js Hub Registry client call
  return `0x${'00'.repeat(4)}` as `0x${string}`;
}

function buildRegisterApplicationPayload(
  programId: string, name: string, description: string,
  repo: string, skillsUrl: string, skillsHash: string,
  idlUrl: string, idlHash: string, track: string
): `0x${string}` {
  // Placeholder — replace with sails-js Hub Registry client call
  return `0x${'00'.repeat(4)}` as `0x${string}`;
}

function buildSubmitApplicationPayload(programId: string): `0x${string}` {
  // Placeholder — replace with sails-js Hub Registry client call
  return `0x${'00'.repeat(4)}` as `0x${string}`;
}

main().catch(console.error);
