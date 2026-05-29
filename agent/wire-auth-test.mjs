/**
 * Phase 4.2e — Authorization Tests (Live)
 * Tests mutating methods on the testnet program with real transactions.
 *
 * Test A1: Oracle.UpdatePrice — no caller check (SEC-002). Any actor should succeed.
 * Test A2: Registry.HeartbeatAgent with wrong agent_id — SEC-001 fix. Should return error.
 * Test A3: Registry.UpdateAgent for non-owned agent — ownership check. Should return error.
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
function scaleU128(n) {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(BigInt(n) & 0xFFFFFFFFFFFFFFFFn, 0);
  buf.writeBigUInt64LE(BigInt(n) >> 64n, 8);
  return buf;
}
function scaleU64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n), 0);
  return buf;
}
function scaleU32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n, 0);
  return buf;
}
function scaleActorId(hex) {
  // ActorId is [u8; 32] — just 32 raw bytes, no length prefix
  return Buffer.from(hex.replace('0x', ''), 'hex');
}
function scaleOption(present, innerBytes) {
  if (!present) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), innerBytes]);
}
function scaleVec(items) {
  const compact = Buffer.from([items.length * 4]);
  return Buffer.concat([compact, ...items]);
}

async function sendAndWaitReply(api, account, payload, timeoutMs = 20000) {
  const source = u8aToHex(decodeAddress(account.address));
  const payloadHex = '0x' + payload.toString('hex');

  const gas = await api.program.calculateGas.handle(source, PROGRAM_ID, payloadHex, 0, true);

  let replyHex = null;
  let replySource = null;

  const unsub = await api.gearEvents.subscribeToGearEvent('UserMessageSent', (event) => {
    const { message } = event.data;
    if (message.source.toHex() === PROGRAM_ID) {
      replyHex = message.payload.toHex();
      replySource = message.source.toHex();
      unsub();
    }
  });

  let extrinsicStatus = null;
  await new Promise((resolve, reject) => {
    api.message.send({
      destination: PROGRAM_ID,
      payload: payloadHex,
      gasLimit: gas.min_limit.toBigInt() * 2n,
      value: 0n,
    }).signAndSend(account, ({ status, events }) => {
      if (status.isInBlock || status.isFinalized) {
        const failed = events.some(e => e.event.section === 'system' && e.event.method === 'ExtrinsicFailed');
        extrinsicStatus = failed ? 'FAILED' : 'SUCCESS';
        if (failed) reject(new Error('ExtrinsicFailed'));
        else resolve(null);
      }
    });
  });

  // Wait for reply
  let waited = 0;
  while (!replyHex && waited < timeoutMs) {
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
  }

  return { replyHex, extrinsicStatus };
}

function decodeReplyResult(replyHex, serviceName, methodName) {
  if (!replyHex) return { ok: null, err: 'no reply received' };
  const raw = Buffer.from(replyHex.replace('0x',''), 'hex');

  // Skip SCALE prefix: compact(len(service)) + service_bytes + compact(len(method)) + method_bytes
  const svcLen = serviceName.length;
  const mthLen = methodName.length;
  const prefixLen = 1 + svcLen + 1 + mthLen;
  const data = raw.slice(prefixLen);

  // Result<T,E>: 0x00 = Ok, 0x01 = Err
  if (data[0] === 0x00) {
    return { ok: true, raw: data.slice(1).toString('hex') };
  } else if (data[0] === 0x01) {
    // Err(String): compact len + bytes
    const errLen = data[1] >> 2;
    const errMsg = data.slice(2, 2 + errLen).toString('utf8');
    return { ok: false, err: errMsg };
  }
  return { ok: null, raw: data.toString('hex') };
}

async function main() {
  const api = await GearApi.create({ providerAddress: ENDPOINT });
  const alice = await GearKeyring.fromSuri('//Alice');
  const aliceHex = u8aToHex(decodeAddress(alice.address));

  // A non-Alice actor id for testing cross-actor checks
  const bobHex = u8aToHex(decodeAddress((await GearKeyring.fromSuri('//Bob')).address));

  console.log(`Alice: ${alice.address} (${aliceHex})`);
  console.log(`Bob hex (no funds, used as target actor_id): ${bobHex}`);
  console.log('');

  const results = {};

  // ─── TEST A1: Oracle.UpdatePrice — no caller check ───
  console.log('=== TEST A1: Oracle.UpdatePrice (expect: SUCCESS, no auth check) ===');
  try {
    const price = BigInt(Math.round(0.00065 * 1e8)); // VARA price
    const confidence = BigInt(Math.round(0.00001 * 1e8));
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const payload = Buffer.concat([
      scaleString('Oracle'),
      scaleString('UpdatePrice'),
      scaleString('VARA/USD'),
      scaleU128(price),
      scaleU128(confidence),
      scaleU64(timestamp),
      scaleU32(1),
    ]);
    const { replyHex, extrinsicStatus } = await sendAndWaitReply(api, alice, payload);
    const decoded = decodeReplyResult(replyHex, 'Oracle', 'UpdatePrice');
    console.log(`  Extrinsic: ${extrinsicStatus}`);
    console.log(`  Reply: ${JSON.stringify(decoded)}`);
    const authGapConfirmed = decoded.ok === true || decoded.err === undefined;
    console.log(`  AUTH-GAP-SEC-002: ${authGapConfirmed ? 'CONFIRMED (any actor can update prices)' : 'UNEXPECTED'}`);
    results.A1 = { status: extrinsicStatus, decoded, authGapConfirmed };
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    results.A1 = { status: 'ERROR', error: e.message };
  }

  console.log('');

  // ─── TEST A2: Registry.HeartbeatAgent with Alice calling for Bob's agent_id ───
  // SEC-001 fix: caller must equal agent_id
  console.log('=== TEST A2: Registry.HeartbeatAgent(bob_id) from Alice (expect: Err — SEC-001 fix) ===');
  try {
    const payload = Buffer.concat([
      scaleString('Registry'),
      scaleString('HeartbeatAgent'),
      scaleActorId(bobHex), // Alice calls heartbeat for Bob's agent_id
    ]);
    const { replyHex, extrinsicStatus } = await sendAndWaitReply(api, alice, payload);
    const decoded = decodeReplyResult(replyHex, 'Registry', 'HeartbeatAgent');
    console.log(`  Extrinsic: ${extrinsicStatus}`);
    console.log(`  Reply: ${JSON.stringify(decoded)}`);
    const sec001Working = decoded.ok === false && decoded.err && decoded.err.includes('only the agent itself');
    console.log(`  SEC-001-FIX: ${sec001Working ? 'VERIFIED (caller check enforced)' : 'FAIL or UNEXPECTED'}`);
    results.A2 = { status: extrinsicStatus, decoded, sec001Working };
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    results.A2 = { status: 'ERROR', error: e.message };
  }

  console.log('');

  // ─── TEST A3: Registry.UpdateAgent for a non-owned agent (Bob's id) from Alice ───
  // Expected: Err("only the owner can update")
  console.log('=== TEST A3: Registry.UpdateAgent(bob_id) from Alice (expect: Err — owner check) ===');
  try {
    // AgentUpdate struct — all Option fields, we pass None for everything
    // Rust struct: { name: Option<String>, description: Option<String>, capabilities: Option<Vec<String>>, endpoint: Option<String> }
    const agentUpdate = Buffer.concat([
      scaleOption(false, Buffer.alloc(0)),  // name: None
      scaleOption(false, Buffer.alloc(0)),  // description: None
      scaleOption(false, Buffer.alloc(0)),  // capabilities: None
      scaleOption(false, Buffer.alloc(0)),  // endpoint: None
    ]);
    const payload = Buffer.concat([
      scaleString('Registry'),
      scaleString('UpdateAgent'),
      scaleActorId(bobHex), // bob's agent_id
      agentUpdate,
    ]);
    const { replyHex, extrinsicStatus } = await sendAndWaitReply(api, alice, payload);
    const decoded = decodeReplyResult(replyHex, 'Registry', 'UpdateAgent');
    console.log(`  Extrinsic: ${extrinsicStatus}`);
    console.log(`  Reply: ${JSON.stringify(decoded)}`);
    const ownerCheckWorking = decoded.ok === false;
    console.log(`  Owner check: ${ownerCheckWorking ? 'ENFORCED' : 'FAILED — any caller can update any agent'}`);
    results.A3 = { status: extrinsicStatus, decoded, ownerCheckWorking };
  } catch (e) {
    console.log(`  ERROR: ${e.message}`);
    results.A3 = { status: 'ERROR', error: e.message };
  }

  await api.disconnect();

  console.log('\n=== AUTH TEST SUMMARY ===');
  console.log(`A1 UpdatePrice (no auth, by design): ${results.A1?.authGapConfirmed ? 'AUTH-GAP confirmed' : results.A1?.status}`);
  console.log(`A2 HeartbeatAgent wrong caller (SEC-001): ${results.A2?.sec001Working ? 'FIXED — error returned' : 'CHECK RESULT'}`);
  console.log(`A3 UpdateAgent non-owner (SEC-003 opposite): ${results.A3?.ownerCheckWorking ? 'ENFORCED' : 'GAP'}`);

  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 120000);
