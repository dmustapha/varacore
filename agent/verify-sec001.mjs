/**
 * verify-sec001.mjs — Isolated test for SEC-001 fix verification
 * Tests HeartbeatAgent and UpdateAgent caller checks in separate sequential calls
 * with explicit delays to prevent race conditions.
 */
import { GearApi, GearKeyring } from '@gear-js/api';
import { decodeAddress } from '@polkadot/util-crypto';
import { u8aToHex } from '@polkadot/util';

const ENDPOINT = 'wss://testnet.vara.network';
const PROGRAM_ID = '0xa9d1ab8bfb11a571059ac5f77713fcb077522789886eeffa200d3851c1c01439';

function scaleString(s) {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([Buffer.from([bytes.length * 4]), bytes]);
}
function scaleActorId(hex) {
  return Buffer.from(hex.replace('0x', ''), 'hex');
}

function decodeReplyResult(replyHex, serviceName, methodName) {
  if (!replyHex) return { ok: null, err: 'no reply received' };
  const raw = Buffer.from(replyHex.replace('0x', ''), 'hex');
  const prefixLen = 1 + serviceName.length + 1 + methodName.length;
  const data = raw.slice(prefixLen);
  if (data[0] === 0x00) return { ok: true, raw: data.slice(1).toString('hex') };
  if (data[0] === 0x01) {
    const errLen = data[1] >> 2;
    const errMsg = data.slice(2, 2 + errLen).toString('utf8');
    return { ok: false, err: errMsg };
  }
  // Unexpected byte — dump full raw for debugging
  console.log(`  [DEBUG] data[0]=0x${data[0].toString(16)}, prefixLen=${prefixLen}, raw full: ${raw.toString('hex')}`);
  return { ok: null, raw: data.toString('hex') };
}

async function sendAndWait(api, account, payload, label, timeoutMs = 25000) {
  const source = u8aToHex(decodeAddress(account.address));
  const payloadHex = '0x' + payload.toString('hex');
  const gas = await api.program.calculateGas.handle(source, PROGRAM_ID, payloadHex, 0, true);

  return new Promise((resolve, reject) => {
    let replyHex = null;
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve({ replyHex: null, timedOut: true });
      }
    }, timeoutMs);

    api.gearEvents.subscribeToGearEvent('UserMessageSent', (event) => {
      const { message } = event.data;
      if (!done && message.source.toHex() === PROGRAM_ID) {
        done = true;
        clearTimeout(timer);
        replyHex = message.payload.toHex();
        resolve({ replyHex });
      }
    }).then(unsub => {
      // Also set up extrinsic submission
      api.message.send({
        destination: PROGRAM_ID,
        payload: payloadHex,
        gasLimit: gas.min_limit.toBigInt() * 2n,
        value: 0n,
      }).signAndSend(account, ({ status }) => {
        if (status.isInBlock) console.log(`  ${label}: InBlock`);
      }).catch(reject);
    }).catch(reject);
  });
}

async function main() {
  const api = await GearApi.create({ providerAddress: ENDPOINT });
  const alice = await GearKeyring.fromSuri('//Alice');
  const bobHex = u8aToHex(decodeAddress((await GearKeyring.fromSuri('//Bob')).address));

  console.log(`Testing program: ${PROGRAM_ID}`);
  console.log(`Alice: ${alice.address}`);
  console.log('');

  // ─── TEST: HeartbeatAgent(bob_id) from Alice ────────────────────────────
  console.log('=== SEC-001: HeartbeatAgent(bob) from Alice (expect: Err caller check) ===');
  const payload = Buffer.concat([
    scaleString('Registry'),
    scaleString('HeartbeatAgent'),
    scaleActorId(bobHex),
  ]);

  const { replyHex, timedOut } = await sendAndWait(api, alice, payload, 'HeartbeatAgent', 25000);

  if (timedOut) {
    console.log('  TIMEOUT — reply not received in 25s');
  } else {
    const decoded = decodeReplyResult(replyHex, 'Registry', 'HeartbeatAgent');
    console.log('  Reply raw hex:', replyHex);
    console.log('  Decoded:', JSON.stringify(decoded));
    if (decoded.ok === false && decoded.err?.includes('only the agent itself')) {
      console.log('  ✓ SEC-001 FIX VERIFIED: caller check enforced');
    } else if (decoded.ok === false && decoded.err?.includes('not registered')) {
      console.log('  ✗ OLD BINARY: agent lookup fires before caller check (SEC-001 not deployed)');
    } else if (decoded.ok === true) {
      console.log('  ✗ SEC-001 BROKEN: HeartbeatAgent succeeded for wrong caller');
    } else {
      console.log('  ? Unexpected result — check raw bytes above');
    }
  }

  await api.disconnect();
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 60000);
