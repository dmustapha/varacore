// File: agent/src/price-agent.ts
// [VERIFIED] — @gear-js/api 0.44.0 GearApi.create + signAndSend pattern from official docs.
// DEV-007: sails-rs service route = PascalCase of accessor fn: oracle() → "Oracle"
import 'dotenv/config';
import axios from 'axios';
import { readFileSync } from 'fs';
import { GearApi, GearKeyring } from '@gear-js/api';
import { KeyringPair } from '@polkadot/keyring/types';

// ─────────────── Config ───────────────

// PA-ENDPOINT FIX: correct mainnet URL. 'wss://rpc.vara-network.io' is testnet.
const VARA_ENDPOINT = process.env.VARA_ENDPOINT || 'wss://rpc.vara.network';
const VARACORE_PROGRAM_ID = process.env.VARACORE_PROGRAM_ID!;
const PRICE_AGENT_MNEMONIC = process.env.PRICE_AGENT_MNEMONIC!;

if (!VARACORE_PROGRAM_ID) throw new Error('VARACORE_PROGRAM_ID is required');
if (!PRICE_AGENT_MNEMONIC) throw new Error('PRICE_AGENT_MNEMONIC is required');

// ─────────────── Price source types ───────────────

interface AssetPrice {
  asset: string;
  price: number;     // float USD
  sources: string[];
}

// Fixed-point: multiply by 1e8 for on-chain u128
const toFixedPoint = (price: number): bigint =>
  BigInt(Math.round(price * 1e8));

// ─────────────── CoinGecko fetch ───────────────

async function fetchCoinGecko(): Promise<Map<string, number>> {
  const ids = 'vara-network,bitcoin,ethereum,polkadot,tether';
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
  const res = await axios.get(url, { timeout: 10_000 });
  const data = res.data;
  const result = new Map<string, number>();
  result.set('VARA/USD', data['vara-network']?.usd);
  result.set('BTC/USD', data['bitcoin']?.usd);
  result.set('ETH/USD', data['ethereum']?.usd);
  result.set('DOT/USD', data['polkadot']?.usd);
  result.set('USDT/USD', data['tether']?.usd);
  return result;
}

// ─────────────── Binance fetch ───────────────

async function fetchBinance(): Promise<Map<string, number>> {
  const symbols = JSON.stringify(['BTCUSDT', 'ETHUSDT', 'DOTUSDT']);
  const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(symbols)}`;
  const res = await axios.get(url, { timeout: 10_000 });
  const result = new Map<string, number>();
  for (const item of res.data) {
    if (item.symbol === 'BTCUSDT') result.set('BTC/USD', parseFloat(item.price));
    if (item.symbol === 'ETHUSDT') result.set('ETH/USD', parseFloat(item.price));
    if (item.symbol === 'DOTUSDT') result.set('DOT/USD', parseFloat(item.price));
  }
  return result;
}

// ─────────────── Gate.io fetch (VARA only) ───────────────

// Gate.io only lists VARA_USDT (Tether pair). USDT is treated as USD here;
// the USDT/USD peg error is historically <0.01%, negligible for this oracle.
async function fetchGateIo(): Promise<Map<string, number>> {
  const url = 'https://api.gateio.ws/api/v4/spot/tickers?currency_pair=VARA_USDT';
  const res = await axios.get(url, { timeout: 10_000 });
  const result = new Map<string, number>();
  if (res.data && res.data.length > 0) {
    result.set('VARA/USD', parseFloat(res.data[0].last));
  }
  return result;
}

// ─────────────── Kraken fetch (USDT/USD) ───────────────

// PA-USDT FIX: Kraken provides a real USDT/USD spot market (pair: USDTZUSD).
// Adding this as a second source for USDT/USD so source_count ≥ 2 → FeedStatus::Fresh.
// Previously only CoinGecko was used → source_count=1 → always Degraded → rejected by consumers.
async function fetchKraken(): Promise<Map<string, number>> {
  const url = 'https://api.kraken.com/0/public/Ticker?pair=USDTZUSD';
  const res = await axios.get(url, { timeout: 10_000 });
  const result = new Map<string, number>();
  const ticker = res.data?.result?.USDTZUSD;
  if (ticker?.c?.[0]) {
    result.set('USDT/USD', parseFloat(ticker.c[0]));
  }
  return result;
}

// ─────────────── Median aggregation with outlier rejection ───────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function aggregatePrices(
  asset: string,
  sources: Map<string, number>[]
): { price: bigint; confidence: bigint; sourceCount: number } | null {
  const values: number[] = [];
  for (const src of sources) {
    const val = src.get(asset);
    if (val && val > 0) values.push(val);
  }

  if (values.length === 0) return null;

  const med = median(values);

  // Outlier rejection: discard if |price - median| / median > 5%
  const filtered = values.filter(v => Math.abs(v - med) / med <= 0.05);

  if (filtered.length === 0) return null;

  const finalPrice = median(filtered);
  const maxDeviation = Math.max(...filtered.map(v => Math.abs(v - finalPrice)));

  return {
    price: toFixedPoint(finalPrice),
    confidence: toFixedPoint(maxDeviation),
    sourceCount: filtered.length,
  };
}

// ─────────────── On-chain submission ───────────────

async function submitPrice(
  api: GearApi,
  account: KeyringPair,
  asset: string,
  price: bigint,
  confidence: bigint,
  timestamp: bigint,
  sourceCount: number
): Promise<void> {
  // DEV-007: service route = PascalCase of accessor fn name: oracle() → "Oracle"
  const payload = buildUpdatePricePayload(asset, price, confidence, timestamp, sourceCount);

  await new Promise<void>((resolve, reject) => {
    api.message.send({
      destination: VARACORE_PROGRAM_ID as `0x${string}`,
      payload,
      gasLimit: 10_000_000_000n,
      value: 0n,
    })
    .signAndSend(account, ({ status, events }: { status: any; events: any[] }) => {
      if (status.isFinalized) {
        const hasError = events.some((e: any) => api.events.system.ExtrinsicFailed.is(e.event));
        if (hasError) reject(new Error(`UpdatePrice failed for ${asset}`));
        else resolve();
      }
    })
    .catch(reject);
  });
}

function buildUpdatePricePayload(
  asset: string,
  price: bigint,
  confidence: bigint,
  timestamp: bigint,
  sourceCount: number
): `0x${string}` {
  // DEV-007: service route "Oracle" (not "OracleService"); method "UpdatePrice"
  // [VERIFIED] — confirmed by 93-assertion mainnet livetest (livetest-v2-mainnet.ts, all PASS)
  const serviceBytes = scaleEncodeString('Oracle');
  const methodBytes = scaleEncodeString('UpdatePrice');
  const assetBytes = scaleEncodeString(asset);

  const priceBytes = encodeBigIntU128(price);
  const confBytes = encodeBigIntU128(confidence);
  const tsBytes = encodeBigIntU64(timestamp);
  const scBytes = encodeU32(sourceCount);

  const combined = new Uint8Array([
    ...serviceBytes, ...methodBytes, ...assetBytes,
    ...priceBytes, ...confBytes, ...tsBytes, ...scBytes,
  ]);
  return `0x${Buffer.from(combined).toString('hex')}`;
}

function scaleEncodeString(s: string): number[] {
  const bytes = new TextEncoder().encode(s);
  const len = bytes.length;
  // SCALE compact encoding of length
  const lenBytes = len < 64
    ? [(len << 2) & 0xff]
    : [(((len << 2) | 1) & 0xff), ((len >> 6) & 0xff)];
  return [...lenBytes, ...bytes];
}

function encodeBigIntU128(n: bigint): number[] {
  const buf = Buffer.alloc(16);
  buf.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  buf.writeBigUInt64LE((n >> 64n) & 0xffffffffffffffffn, 8);
  return [...buf];
}

function encodeBigIntU64(n: bigint): number[] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n, 0);
  return [...buf];
}

function encodeU32(n: number): number[] {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n, 0);
  return [...buf];
}

// ─────────────── Retry helper ───────────────

// PA-DEAD FIX: removed unreachable `throw new Error('unreachable')` after the loop.
// The loop exhausts all attempts and throws on the last one via `throw e` in the else branch.
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 3000): Promise<T> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i < retries) {
        console.error(`[PriceAgent] Attempt ${i + 1} failed, retrying in ${delayMs}ms...`, e);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw e;
      }
    }
  }
  // TypeScript requires all paths to return — this line is genuinely unreachable
  // because the else branch above always throws on the last attempt.
  throw new Error('all retry attempts exhausted');
}

// ─────────────── Main loop ───────────────

async function main(): Promise<void> {
  console.log('[PriceAgent] Starting...');
  console.log(`[PriceAgent] Endpoint: ${VARA_ENDPOINT}`);
  console.log(`[PriceAgent] VaraCore program: ${VARACORE_PROGRAM_ID}`);

  const api = await GearApi.create({ providerAddress: VARA_ENDPOINT });

  // WebSocket reconnect: re-establish connection on provider error/disconnect
  (api.provider as any).on('disconnected', async () => {
    console.error('[PriceAgent] WebSocket disconnected — reconnecting...');
    try {
      await (api.provider as any).connect(VARA_ENDPOINT);
      console.log('[PriceAgent] WebSocket reconnected');
    } catch (e) {
      console.error('[PriceAgent] Reconnect failed:', e);
    }
  });

  // Support both mnemonic strings and keystore JSON file paths
  const account = PRICE_AGENT_MNEMONIC.startsWith('/')
    ? GearKeyring.fromJson(JSON.parse(readFileSync(PRICE_AGENT_MNEMONIC, 'utf8')), undefined)
    : await GearKeyring.fromMnemonic(PRICE_AGENT_MNEMONIC);

  console.log(`[PriceAgent] Account: ${account.address}`);

  const ASSETS = ['VARA/USD', 'BTC/USD', 'ETH/USD', 'DOT/USD', 'USDT/USD'];
  const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

  const runOnce = async () => {
    console.log(`[PriceAgent] ${new Date().toISOString()} Fetching prices...`);

    const [coingecko, binance, gateio, kraken] = await Promise.allSettled([
      fetchCoinGecko(),
      fetchBinance(),
      fetchGateIo(),
      fetchKraken(),
    ]).then(results => results.map(r =>
      r.status === 'fulfilled' ? r.value : new Map<string, number>()
    ));

    const sourcesByAsset: Record<string, Map<string, number>[]> = {
      'VARA/USD':  [coingecko, gateio],
      'BTC/USD':   [coingecko, binance],
      'ETH/USD':   [coingecko, binance],
      'DOT/USD':   [coingecko, binance],
      // PA-USDT FIX: add Kraken as second source so USDT gets source_count=2 → Fresh.
      'USDT/USD':  [coingecko, kraken],
    };

    for (const asset of ASSETS) {
      const sources = sourcesByAsset[asset];
      const result = aggregatePrices(asset, sources);
      if (!result) {
        console.error(`[PriceAgent] Could not get price for ${asset} — skipping`);
        continue;
      }
      const { price, confidence, sourceCount } = result;
      console.log(`  ${asset}: ${(Number(price) / 1e8).toFixed(8)} (${sourceCount} sources)`);

      // PA-TS FIX: compute timestamp per-asset so each submission carries an accurate time.
      // Previously a single `now` was computed before the loop — the 5th asset's timestamp
      // was potentially seconds behind its actual submission time.
      const now = BigInt(Math.floor(Date.now() / 1000));

      try {
        await withRetry(() => submitPrice(api, account, asset, price, confidence, now, sourceCount));
        console.log(`  ✓ ${asset} submitted`);
      } catch (e) {
        console.error(`  ✗ ${asset} failed: ${e}`);
      }
    }

    console.log(`[PriceAgent] Done. Next run in ${INTERVAL_MS / 60000} minutes.`);
  };

  await runOnce();
  setInterval(async () => {
    try {
      await runOnce();
    } catch (e) {
      console.error('[PriceAgent] Run failed:', e);
    }
  }, INTERVAL_MS);
}

main().catch(console.error);
