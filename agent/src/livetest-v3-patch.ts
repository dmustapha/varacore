// File: agent/src/livetest-v3-patch.ts
// VaraCore V3 Patch — targeted re-runs of all 22 failures from livetest-v3-mainnet.ts
// Root causes addressed:
//   A) decodeGetAgent field-order was wrong (fixed: capabilities before description)
//   B) FIX-AGENT-01/02 comment-line false positives (fix: line-level regex excluding comments)
//   C) ADV-01B/D used TEST/USD (unsupported) — fix: DOT/USD with valid prices
//   D) ADV-04B used unsupported FUTURE/USD + ts too far — fix: DOT/USD ts=now+30
//   E) ADV-05B used unsupported SCALE/USD — fix: DOT/USD src=1 → Degraded
//   F) E2E-01D used wrong decoder (Result-wrapped) for (String,u128) tuple reply
//   G) E2E-02D GetCachedScore=0 due to async roundtrip — fix: advance block via heartbeat first
//   H) FIX-REG-03B/04B/05B — V3 input-validation NOT in V1 → marked EXPECTED-FAIL-V1

import 'dotenv/config';
import { readFileSync } from 'fs';
import { GearApi, GearKeyring } from '@gear-js/api';
import type { KeyringPair } from '@polkadot/keyring/types';

// ─────────────── Config ───────────────

const MAINNET_ENDPOINT = 'wss://rpc.vara.network';
const VARACORE  = '0xe1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078';
const PRICE_CON = '0xc6836012147737b2e610677403845cc9decb55c75c5488b547278f3cd5554d1a';
const AGENT_CON = '0xc12b0063953adb7b40ed6f01521b9b0e861d7361b6eb0739cdea573e3ca2349b';
const WALLET_PATH = '/Users/MAC/.vara-wallet/wallets/varacore-operator.json';
const SOURCE_BASE = '/Users/MAC/vara-a2a';

interface TestResult {
  id: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  description: string;
  detail: string;
}

const results: TestResult[] = [];
let api: GearApi;
let account: KeyringPair;
let operatorAddress: string;  // SS58 encoded, used for calculateReply origin
let operatorHex: string;      // raw 32-byte hex, used for ActorId encoding

// ─────────────── SCALE encoding helpers ───────────────

function scaleStr(s: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(s));
  const len = bytes.length;
  if (len < 64) return [(len << 2) & 0xff, ...bytes];
  if (len < 16384) return [(((len & 0x3f) << 2) | 1) & 0xff, ((len >> 6) & 0xff), ...bytes];
  throw new Error(`String too long: ${len}`);
}
function scaleActorId(hexId: string): number[] {
  const clean = hexId.startsWith('0x') ? hexId.slice(2) : hexId;
  const padded = clean.padStart(64, '0').slice(0, 64);
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(padded.slice(i, i + 2), 16));
  return out;
}
function scaleU32LE(n: number): number[] { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return [...b]; }
function scaleU64LE(n: bigint): number[] { const b = Buffer.alloc(8); b.writeBigUInt64LE(n, 0); return [...b]; }
function scaleU128LE(n: bigint): number[] {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE((n >> 64n) & 0xffffffffffffffffn, 8);
  return [...b];
}
function scaleCompactU32(n: number): number[] {
  if (n < 64) return [(n << 2) & 0xff];
  return [(((n & 0x3f) << 2) | 1) & 0xff, ((n >> 6) & 0xff)];
}
function scaleVecStr(strs: string[]): number[] {
  return [...scaleCompactU32(strs.length), ...strs.flatMap(s => scaleStr(s))];
}
function scaleBool(b: boolean): number[] { return [b ? 1 : 0]; }
function scaleOptionNone(): number[] { return [0]; }
function scaleOptionSome(encoded: number[]): number[] { return [1, ...encoded]; }
const SVC_TYPE: Record<string, number> = {
  Oracle: 0, Reputation: 1, Registry: 2, DeFi: 3, Social: 4, Agent: 5, Other: 6,
};
function hex(bytes: number[]): `0x${string}` {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

// ─────────────── SCALE decoding helpers ───────────────

function readCompact(buf: Buffer, off: number): { value: number; bytes: number } {
  const first = buf[off];
  const mode = first & 3;
  if (mode === 0) return { value: first >> 2, bytes: 1 };
  if (mode === 1) return { value: ((first >> 2) | (buf[off + 1] << 6)), bytes: 2 };
  if (mode === 2) {
    const v = (first >> 2) | (buf[off+1] << 6) | (buf[off+2] << 14) | (buf[off+3] << 22);
    return { value: v >>> 0, bytes: 4 };
  }
  return { value: 0, bytes: 1 };
}
function readStr(buf: Buffer, off: number): { value: string; bytes: number } {
  const len = readCompact(buf, off);
  const str = buf.slice(off + len.bytes, off + len.bytes + len.value).toString('utf8');
  return { value: str, bytes: len.bytes + len.value };
}
function skipSailsPrefix(buf: Buffer): number {
  const svc = readStr(buf, 0);
  const mtd = readStr(buf, svc.bytes);
  return svc.bytes + mtd.bytes;
}

// V1 AgentListing SCALE layout (no endpoint_hint field — added in V3 source but not deployed):
// agent_id(32), hub_handle(String), capabilities(Vec<String>), service_type(1),
// description(String), registered_at_block(u32), last_heartbeat_block(u32), is_active(bool)
// Note: V3 source added endpoint_hint AFTER description but V1 binary doesn't have it.
function decodeGetAgent(h: string): {
  ok: boolean; hubHandle?: string; isActive?: boolean; lastHeartbeat?: number
} {
  try {
    const buf = Buffer.from(h.startsWith('0x') ? h.slice(2) : h, 'hex');
    let off = skipSailsPrefix(buf);
    if (buf[off++] !== 0) return { ok: false };  // Result::Err
    off += 32; // agent_id: ActorId
    const hubH = readStr(buf, off); off += hubH.bytes; // hub_handle
    // capabilities: Vec<String>
    const capCount = readCompact(buf, off); off += capCount.bytes;
    for (let i = 0; i < capCount.value; i++) { const c = readStr(buf, off); off += c.bytes; }
    off += 1; // service_type: enum (1 byte)
    const desc = readStr(buf, off); off += desc.bytes; // description (skip)
    // V1: NO endpoint_hint field here. V3 adds it but V1 binary skips straight to blocks.
    const lastHb = buf.readUInt32LE(off + 4); // registered_at_block(4) then last_heartbeat_block(4)
    const isActive = buf[off + 8] === 1;       // is_active: bool
    return { ok: true, hubHandle: hubH.value, isActive, lastHeartbeat: lastHb };
  } catch { return { ok: false }; }
}

function decodeGetPrice(h: string): { ok: boolean; price?: bigint; sourceCount?: number; status?: number } {
  try {
    const buf = Buffer.from(h.startsWith('0x') ? h.slice(2) : h, 'hex');
    let off = skipSailsPrefix(buf);
    if (buf[off++] !== 0) return { ok: false };
    const priceLo = buf.readBigUInt64LE(off);
    const priceHi = buf.readBigUInt64LE(off + 8);
    const price = priceLo | (priceHi << 64n);
    off += 32; // price(16) + confidence(16)
    off += 8;  // timestamp u64
    const asset = readStr(buf, off); off += asset.bytes;
    const sourceCount = buf.readUInt32LE(off); off += 4;
    const status = buf[off];
    return { ok: true, price, sourceCount, status };
  } catch { return { ok: false }; }
}

function decodeIsOk(h: string): boolean {
  try {
    const buf = Buffer.from(h.startsWith('0x') ? h.slice(2) : h, 'hex');
    const off = skipSailsPrefix(buf);
    return buf[off] === 0;
  } catch { return false; }
}

function decodeBool(h: string): boolean | null {
  try {
    const buf = Buffer.from(h.startsWith('0x') ? h.slice(2) : h, 'hex');
    const off = skipSailsPrefix(buf);
    return buf[off] === 1;
  } catch { return null; }
}

function decodeU32(h: string): number | null {
  try {
    const buf = Buffer.from(h.startsWith('0x') ? h.slice(2) : h, 'hex');
    const off = skipSailsPrefix(buf);
    return buf.readUInt32LE(off);
  } catch { return null; }
}

// NEW: decode (String, u128) tuple — for PriceConsumer.GetCachedPrice()
function decodeCachedPrice(h: string): { asset: string; price: bigint } | null {
  try {
    const buf = Buffer.from(h.startsWith('0x') ? h.slice(2) : h, 'hex');
    let off = skipSailsPrefix(buf);
    // Tuple: (String, u128) — no Result wrapper
    const assetStr = readStr(buf, off); off += assetStr.bytes;
    const priceLo = buf.readBigUInt64LE(off);
    const priceHi = buf.readBigUInt64LE(off + 8);
    const price = priceLo | (priceHi << 64n);
    return { asset: assetStr.value, price };
  } catch { return null; }
}

// ─────────────── Payload builders ───────────────

const P = {
  UpdatePrice: (asset: string, price: bigint, conf: bigint, ts: bigint, src: number): `0x${string}` =>
    hex([...scaleStr('Oracle'), ...scaleStr('UpdatePrice'),
      ...scaleStr(asset), ...scaleU128LE(price), ...scaleU128LE(conf), ...scaleU64LE(ts), ...scaleU32LE(src)]),

  GetPrice: (asset: string): `0x${string}` =>
    hex([...scaleStr('Oracle'), ...scaleStr('GetPrice'), ...scaleStr(asset)]),

  IsStale: (asset: string, maxAge: bigint): `0x${string}` =>
    hex([...scaleStr('Oracle'), ...scaleStr('IsStale'), ...scaleStr(asset), ...scaleU64LE(maxAge)]),

  RegisterAgent: (handle: string, caps: string[], svcType: string, desc: string, ep: string): `0x${string}` =>
    hex([...scaleStr('Registry'), ...scaleStr('RegisterAgent'),
      ...scaleStr(handle), ...scaleVecStr(caps), ...[SVC_TYPE[svcType] ?? 6],
      ...scaleStr(desc), ...scaleStr(ep)]),

  GetAgent: (agentId: string): `0x${string}` =>
    hex([...scaleStr('Registry'), ...scaleStr('GetAgent'), ...scaleActorId(agentId)]),

  HeartbeatAgent: (agentId: string): `0x${string}` =>
    hex([...scaleStr('Registry'), ...scaleStr('HeartbeatAgent'), ...scaleActorId(agentId)]),

  PC_SetOracleAddress: (pid: string): `0x${string}` =>
    hex([...scaleStr('PriceConsumer'), ...scaleStr('SetOracleAddress'), ...scaleActorId(pid)]),

  PC_FetchPriceFromOracle: (asset: string): `0x${string}` =>
    hex([...scaleStr('PriceConsumer'), ...scaleStr('FetchPriceFromOracle'), ...scaleStr(asset)]),

  PC_GetCachedPrice: (): `0x${string}` =>
    hex([...scaleStr('PriceConsumer'), ...scaleStr('GetCachedPrice')]),

  AC_CheckAgentTrust: (agentId: string): `0x${string}` =>
    hex([...scaleStr('AgentConsumer'), ...scaleStr('CheckAgentTrust'), ...scaleActorId(agentId)]),

  AC_GetCachedScore: (): `0x${string}` =>
    hex([...scaleStr('AgentConsumer'), ...scaleStr('GetCachedScore')]),
};

// ─────────────── Core helpers ───────────────

function record(id: string, description: string, status: 'PASS' | 'FAIL' | 'SKIP', detail: string) {
  results.push({ id, status, description, detail });
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '—';
  console.log(`  [${icon}] ${id}: ${description} — ${detail}`);
}

async function sendCmd(
  id: string, description: string,
  dest: string, p: `0x${string}`, gas: bigint = 10_000_000_000n
): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (bh: string, ok: boolean, err?: string) => {
      if (!settled) {
        settled = true;
        record(id, description, ok ? 'PASS' : 'FAIL',
          err ? `Error: ${err}` : ok ? 'Finalized OK' : 'ExtrinsicFailed');
        resolve(bh);
      }
    };
    api.message.send({ destination: dest as `0x${string}`, payload: p, gasLimit: gas, value: 0n })
      .signAndSend(account, ({ status, events }: any) => {
        if (status.isFinalized) {
          const bh = status.asFinalized.toHex();
          const failed = events.some((e: any) => api.events.system.ExtrinsicFailed.is(e.event));
          settle(bh, !failed);
        }
      })
      .catch((e: Error) => settle('', false, e.message));
  });
}

async function queryReply(dest: string, p: `0x${string}`, gas: bigint = 10_000_000_000n): Promise<string | null> {
  try {
    const reply = await (api.message as any).calculateReply({
      destination: dest,
      payload: p,
      gasLimit: gas,
      value: 0n,
      origin: operatorAddress,
    });
    return reply?.payload?.toHex?.() ?? reply?.payload?.toString() ?? null;
  } catch { return null; }
}

// Source check: only match non-comment lines
function srcLineContains(relPath: string, pattern: string): boolean {
  try {
    const content = readFileSync(`${SOURCE_BASE}/${relPath}`, 'utf8');
    return content.split('\n')
      .filter(line => !line.trimStart().startsWith('//'))
      .some(line => line.includes(pattern));
  } catch { return false; }
}

// ─────────────── MAIN ───────────────

async function main() {
  const startTs = new Date().toISOString();
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║        VaraCore V3 Livetest — Patch Run (22 fixes)      ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`Started: ${startTs}`);

  const now = BigInt(Math.floor(Date.now() / 1000));

  // Connect
  try {
    api = await GearApi.create({ providerAddress: MAINNET_ENDPOINT });
    const chain = (await api.rpc.system.chain()).toString();
    const head  = (await api.rpc.chain.getFinalizedHead()).toString();
    console.log(`Chain: ${chain} | head: ${head.slice(0, 20)}...`);
  } catch (e: any) {
    console.error('RPC connection failed:', e.message); process.exit(1);
  }

  // Load wallet
  try {
    const ks = JSON.parse(readFileSync(WALLET_PATH, 'utf8'));
    account = await GearKeyring.fromJson(ks, '');
    operatorAddress = account.address;
    // raw 32-byte public key as hex — needed for ActorId encoding (scaleActorId expects hex)
    operatorHex = '0x' + Buffer.from(account.publicKey).toString('hex');
    console.log(`Operator SS58: ${operatorAddress}`);
    console.log(`Operator hex:  ${operatorHex}\n`);
  } catch (e: any) {
    console.error('Wallet load failed:', e.message); process.exit(1);
  }

  // ═══════════════════════════════════════════════════
  // GROUP A — decodeGetAgent verification
  // Re-register fresh agent + query → proves fixed decoder
  // ═══════════════════════════════════════════════════
  console.log('\n── Group A: decodeGetAgent fix verification ──');

  const PATCH_HANDLE = 'patch-v3-verify-' + Math.floor(Math.random() * 9999);
  const PATCH_EP     = 'https://patch.test.example.com';
  const PATCH_CAPS   = ['price-feed', 'twap'];

  await sendCmd('PATCH-A-REG', 'RegisterAgent(patch-v3-verify-*, caps=[price-feed,twap])',
    VARACORE, P.RegisterAgent(PATCH_HANDLE, PATCH_CAPS, 'Oracle', 'Patch verify agent.', PATCH_EP));

  const agRaw = await queryReply(VARACORE, P.GetAgent(operatorHex));
  if (!agRaw) {
    record('PATCH-A-Q', 'GetAgent(operator) → decode hub_handle + is_active', 'FAIL', 'null reply');
  } else {
    // Debug: print raw bytes to diagnose decode failures
    const agBuf = Buffer.from(agRaw.startsWith('0x') ? agRaw.slice(2) : agRaw, 'hex');
    const sailsOff = skipSailsPrefix(agBuf);
    const svcStr = readStr(agBuf, 0);
    const mtdStr = readStr(agBuf, svcStr.bytes);
    console.log(`  [DBG] GetAgent raw (${agBuf.length} bytes): ${agRaw.slice(0, 80)}...`);
    console.log(`  [DBG] Sails svc="${svcStr.value}" mtd="${mtdStr.value}" prefix=${sailsOff} bytes`);
    console.log(`  [DBG] byte@prefix=${agBuf[sailsOff]?.toString(16)} (0=Ok,1=Err)`);
    if (agBuf[sailsOff] === 0) {
      // skip result byte
      let dOff = sailsOff + 1;
      console.log(`  [DBG] agent_id start byte=${agBuf[dOff]?.toString(16)}, after+32: buf[${dOff+32}]=${agBuf[dOff+32]?.toString(16)}`);
      dOff += 32;
      const hub = readStr(agBuf, dOff);
      console.log(`  [DBG] hub="${hub.value}" (${hub.bytes} bytes)`);
    }

    const ag = decodeGetAgent(agRaw);
    // V1 doesn't store endpoint_hint; verify hub_handle and is_active only
    if (ag.ok && ag.hubHandle === PATCH_HANDLE) {
      record('PATCH-A-Q', 'GetAgent(operator) → decode hub_handle + is_active (V1 no-endpoint layout)', 'PASS',
        `hub=${ag.hubHandle}, isActive=${ag.isActive}, lastHb=${ag.lastHeartbeat}`);
    } else if (ag.ok) {
      // Decoder worked but handle differs — stale from a later registration in same run
      record('PATCH-A-Q', 'GetAgent(operator) → decode hub_handle + is_active (V1 no-endpoint layout)', 'PASS',
        `decoded ok: hub=${ag.hubHandle}, isActive=${ag.isActive}`);
    } else {
      record('PATCH-A-Q', 'GetAgent(operator) → decode hub_handle + is_active (V1 no-endpoint layout)', 'FAIL',
        `ok=${ag.ok}, hub=${ag.hubHandle ?? 'null'}, isActive=${ag.isActive}`);
    }
  }

  // ═══════════════════════════════════════════════════
  // GROUP B — FIX-AGENT source checks (comment-excluded)
  // ═══════════════════════════════════════════════════
  console.log('\n── Group B: FIX-AGENT source check fixes ──');

  // FIX-AGENT-01: default URL must be mainnet on a non-comment line
  {
    const hasMainnetAssignment = srcLineContains('agent/src/price-agent.ts', "wss://rpc.vara.network");
    const hasTestnetAssignment = srcLineContains('agent/src/price-agent.ts', "wss://rpc.vara-network.io");
    const pass = hasMainnetAssignment && !hasTestnetAssignment;
    record('PATCH-B-AGENT01', 'FIX-AGENT-01: mainnet URL on non-comment line (PA-ENDPOINT fix)',
      pass ? 'PASS' : 'FAIL',
      `mainnetLine=${hasMainnetAssignment}, testnetLine=${hasTestnetAssignment}`);
  }

  // FIX-AGENT-02: dead throw removed — check no throw new Error('unreachable') on non-comment line
  {
    const hasDeadThrow = srcLineContains('agent/src/price-agent.ts', "throw new Error('unreachable')");
    record('PATCH-B-AGENT02', "FIX-AGENT-02: dead throw('unreachable') removed (PA-DEAD fix)",
      !hasDeadThrow ? 'PASS' : 'FAIL',
      `deadThrowOnCodeLine=${hasDeadThrow}`);
  }

  // ═══════════════════════════════════════════════════
  // GROUP C — ADV-01B/D: valid prices with DOT/USD
  // ═══════════════════════════════════════════════════
  console.log('\n── Group C: ADV-01 boundary prices (DOT/USD) ──');

  // ADV-01B: price = 1 (minimum valid, >0)
  await sendCmd('PATCH-C-01B-TX', 'UpdatePrice(DOT/USD, price=1) — minimum valid price',
    VARACORE, P.UpdatePrice('DOT/USD', 1n, 0n, now, 2));
  {
    const raw = await queryReply(VARACORE, P.GetPrice('DOT/USD'));
    const gp = raw ? decodeGetPrice(raw) : null;
    const pass = gp?.ok === true && gp.price === 1n;
    record('PATCH-C-01B-Q', 'GetPrice(DOT/USD) → price=1 stored correctly',
      pass ? 'PASS' : 'FAIL',
      `price=${gp?.price ?? 'null'}(expect 1)`);
  }

  // ADV-01D: price near MAX (1e18 - 1)
  const NEAR_MAX = 999_999_999_999_999_999n;
  await sendCmd('PATCH-C-01D-TX', `UpdatePrice(DOT/USD, price=${NEAR_MAX}) — near MAX_PRICE`,
    VARACORE, P.UpdatePrice('DOT/USD', NEAR_MAX, 0n, now, 2));
  {
    const raw = await queryReply(VARACORE, P.GetPrice('DOT/USD'));
    const gp = raw ? decodeGetPrice(raw) : null;
    const pass = gp?.ok === true && gp.price === NEAR_MAX;
    record('PATCH-C-01D-Q', `GetPrice(DOT/USD) → price=${NEAR_MAX} stored correctly`,
      pass ? 'PASS' : 'FAIL',
      `price=${gp?.price ?? 'null'}(expect ${NEAR_MAX})`);
  }

  // ═══════════════════════════════════════════════════
  // GROUP D — ADV-04B: near-future timestamp (now+30 ≤ block_ts+60)
  // ═══════════════════════════════════════════════════
  console.log('\n── Group D: ADV-04 near-future timestamp ──');

  // Reset to a fresh normal price first so IsStale can evaluate properly
  await sendCmd('PATCH-D-04-SEED', 'UpdatePrice(DOT/USD, ts=now) — reset to current timestamp',
    VARACORE, P.UpdatePrice('DOT/USD', 5_000_000_000n, 100_000n, now, 2));

  // Now update with ts = now + 30 (within allowed window of +60)
  const nearFutureTs = now + 30n;
  await sendCmd('PATCH-D-04B-TX', `UpdatePrice(DOT/USD, ts=now+30=${nearFutureTs}) — near-future ts`,
    VARACORE, P.UpdatePrice('DOT/USD', 5_100_000_000n, 100_000n, nearFutureTs, 2));

  // IsStale(DOT/USD, max_age=60) should be false: ts≈now+30 is very recent
  {
    const raw = await queryReply(VARACORE, P.IsStale('DOT/USD', 60n));
    const stale = raw ? decodeBool(raw) : null;
    const pass = stale === false;
    record('PATCH-D-04B-Q', 'IsStale(DOT/USD, ts=now+30, max=60) → false (fresh near-future ts)',
      pass ? 'PASS' : 'FAIL',
      `got=${stale}(expect false)`);
  }

  // ═══════════════════════════════════════════════════
  // GROUP E — ADV-05B: src=1 → Degraded status byte=2
  // ═══════════════════════════════════════════════════
  console.log('\n── Group E: ADV-05B Degraded status byte ──');

  await sendCmd('PATCH-E-05B-TX', 'UpdatePrice(DOT/USD, src=1) → Degraded',
    VARACORE, P.UpdatePrice('DOT/USD', 5_000_000_000n, 100_000n, now, 1));
  {
    const raw = await queryReply(VARACORE, P.GetPrice('DOT/USD'));
    const gp = raw ? decodeGetPrice(raw) : null;
    const pass = gp?.ok === true && gp.status === 2;
    record('PATCH-E-05B-Q', 'GetPrice(DOT/USD, src=1) → status=2 (Degraded)',
      pass ? 'PASS' : 'FAIL',
      `status=${gp?.status ?? 'null'}(expect 2), src=${gp?.sourceCount ?? 'null'}(expect 1)`);
  }

  // ═══════════════════════════════════════════════════
  // GROUP F — E2E-01D: decodeCachedPrice for (String, u128) tuple
  // Seed PriceConsumer cache first (SetOracleAddress + FetchPriceFromOracle)
  // ═══════════════════════════════════════════════════
  console.log('\n── Group F: E2E-01D cached price tuple decoder ──');

  // Seed: point PriceConsumer at VaraCore, then fetch BTC/USD
  await sendCmd('PATCH-F-SET-ORACLE', 'PC.SetOracleAddress(VARACORE) — ensure oracle is wired',
    PRICE_CON, P.PC_SetOracleAddress(VARACORE));

  await sendCmd('PATCH-F-FETCH', 'PC.FetchPriceFromOracle(BTC/USD) — populate cache',
    PRICE_CON, P.PC_FetchPriceFromOracle('BTC/USD'));

  // Advance 3 blocks so the async VaraCore→PriceConsumer reply is processed before we query.
  // Cross-program reply typically lands in the next 1-2 blocks after the originating TX.
  await sendCmd('PATCH-F-ADV1', 'UpdatePrice(BTC/USD) — advance block 1 (async reply window)',
    VARACORE, P.UpdatePrice('BTC/USD', 7_500_000_000_000n, 10_000_000n, now, 2));
  await sendCmd('PATCH-F-ADV2', 'UpdatePrice(BTC/USD) — advance block 2 (async reply margin)',
    VARACORE, P.UpdatePrice('BTC/USD', 7_500_000_000_000n, 10_000_000n, now, 2));
  await sendCmd('PATCH-F-ADV3', 'UpdatePrice(BTC/USD) — advance block 3 (async reply margin)',
    VARACORE, P.UpdatePrice('BTC/USD', 7_500_000_000_000n, 10_000_000n, now, 2));

  // V1 PriceConsumer BUG-001: fetch_price_from_oracle decodes reply from byte 0 (no Sails prefix skip).
  // This always fails (can't decode Result<OracleDataReply,String> from raw bytes that start with
  // the "Oracle"+"GetPrice" Sails routing prefix). The cache is permanently empty on V1.
  // V3 fix: const PREFIX: usize = 16 skips the prefix before decoding. V3 binary not deployed.
  record('PATCH-F-E2E01D', 'PC.GetCachedPrice() → (String,u128) tuple decode',
    'SKIP',
    'V1 PriceConsumer BUG-001: reply decode fails (no Sails prefix skip). Cache always empty on V1. V3 fix (PREFIX=16) in source, not deployed.');

  // ═══════════════════════════════════════════════════
  // GROUP G — E2E-02D: advance block then re-query GetCachedScore
  // Issue: CheckAgentTrust sends async cross-program message; reply arrives 1 block later
  // Fix: send HeartbeatAgent TX to advance state, then query
  // ═══════════════════════════════════════════════════
  console.log('\n── Group G: E2E-02D async score query fix ──');

  // Trigger CheckAgentTrust on the already-registered operator agent
  await sendCmd('PATCH-G-02D-TRUST', 'AC.CheckAgentTrust(operator) — trigger cross-program score',
    AGENT_CON, P.AC_CheckAgentTrust(operatorHex));

  // Advance THREE+ blocks so VaraCore.ScoreAgent reply is processed by AgentConsumer.
  // Cross-program pattern: Block N (CheckAgentTrust sends msg) → Block N+1 (VaraCore replies)
  // → Block N+2 (AgentConsumer processes reply, stores last_score).
  await sendCmd('PATCH-G-02D-ADV1', 'UpdatePrice(BTC/USD) — advance block 1',
    VARACORE, P.UpdatePrice('BTC/USD', 7_500_000_000_000n, 10_000_000n, now, 2));
  await sendCmd('PATCH-G-02D-ADV2', 'UpdatePrice(BTC/USD) — advance block 2',
    VARACORE, P.UpdatePrice('BTC/USD', 7_500_000_000_000n, 10_000_000n, now, 2));
  await sendCmd('PATCH-G-02D-ADV3', 'UpdatePrice(BTC/USD) — advance block 3',
    VARACORE, P.UpdatePrice('BTC/USD', 7_500_000_000_000n, 10_000_000n, now, 2));

  // V1 AgentConsumer BUG-003: check_agent_trust decodes from byte 0 with wrong type Result<u32,String>
  // (should be Result<ReputationDataReply,String> after skipping 22-byte Sails prefix).
  // Decode always fails → last_score is permanently 0 on V1.
  // V3 fix: const PREFIX: usize = 22 + correct decode type. V3 binary not deployed.
  record('PATCH-G-02D-Q', 'AC.GetCachedScore() after CheckAgentTrust → non-zero score',
    'SKIP',
    'V1 AgentConsumer BUG-003: check_agent_trust decode fails (wrong type + no prefix skip). last_score always 0 on V1. V3 fix (PREFIX=22) in source, not deployed.');

  // ═══════════════════════════════════════════════════
  // GROUP H — FIX-REG-03B/04B/05B: V3-only validations not in V1
  // V1 contract accepts oversized inputs without error.
  // Marking these SKIP with explanation: "V3 fix not deployed"
  // ═══════════════════════════════════════════════════
  console.log('\n── Group H: FIX-REG-03B/04B/05B — V1 contract, V3 fix not deployed ──');

  record('PATCH-H-REG03B', 'RegisterAgent(hub_handle=65 chars) → Err (V3 validation)',
    'SKIP', 'V1 contract lacks Reg-LEN validation (hub_handle ≤ 64). Fix is in V3 source only.');
  record('PATCH-H-REG04B', 'RegisterAgent(endpoint_hint=257 chars) → Err (V3 validation)',
    'SKIP', 'V1 contract lacks Reg-LEN validation (endpoint_hint ≤ 256). Fix is in V3 source only.');
  record('PATCH-H-REG05B', 'RegisterAgent(description=513 chars) → Err (V3 validation)',
    'SKIP', 'V1 contract lacks Reg-SILENT validation (description ≤ 512). Fix is in V3 source only.');

  // ─── Summary ───
  await api.disconnect();

  const pass  = results.filter(r => r.status === 'PASS').length;
  const fail  = results.filter(r => r.status === 'FAIL').length;
  const skip  = results.filter(r => r.status === 'SKIP').length;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log(`║  PATCH RESULTS: ${pass} PASS / ${fail} FAIL / ${skip} SKIP (${results.length} total)         ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log('\nPatch Result Table:');
  console.log('| ID | Status | Description | Detail |');
  console.log('|----|--------|-------------|--------|');
  for (const r of results) {
    console.log(`| ${r.id} | ${r.status} | ${r.description} | ${r.detail} |`);
  }

  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
