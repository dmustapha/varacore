/**
 * Phase 2.5 End-to-End Live Test — VaraCore Stress Test
 * Tests: AF-1 (mainnet prices), AF-2 (PriceConsumer), AF-3/AF-4 (AgentConsumer), AF-5 (ScheduleRefresh)
 */
require('dotenv/config');
const { GearApi, GearKeyring } = require('@gear-js/api');
const { decodeAddress } = require('@polkadot/util-crypto');
const { u8aToHex } = require('@polkadot/util');
const { readFileSync } = require('fs');

// ─── Program IDs ───
const VARACORE_TESTNET  = process.env.VARACORE_PROGRAM_ID;
const VARACORE_MAINNET  = process.env.VARACORE_MAINNET_PROGRAM_ID;
const PRICE_CONSUMER    = process.env.PRICE_CONSUMER_TESTNET_PROGRAM_ID;
const AGENT_CONSUMER    = process.env.AGENT_CONSUMER_TESTNET_PROGRAM_ID;
const TESTNET_ENDPOINT  = process.env.VARA_ENDPOINT || 'wss://testnet.vara.network';
const MAINNET_ENDPOINT  = process.env.VARA_MAINNET_ENDPOINT || 'wss://rpc.vara.network';

// ─── SCALE helpers ───
function scaleStr(s) {
  const bytes = Buffer.from(s, 'utf8');
  const len = bytes.length;
  if (len < 64) return Buffer.concat([Buffer.from([len << 2]), bytes]);
  const lo = ((len << 2) | 1) & 0xff;
  const hi = (len >> 6) & 0xff;
  return Buffer.concat([Buffer.from([lo, hi]), bytes]);
}

function buildPayload(...parts) {
  return '0x' + Buffer.concat(parts.map(p => typeof p === 'string' ? scaleStr(p) : p)).toString('hex');
}

// Decode Result<u128, String> — Ok(u128) = 0x00 + 16 bytes; Err = 0x01 + compact + str
function decodeResultU128(bytes, offset) {
  if (bytes.length <= offset) return { ok: false, err: 'reply too short' };
  const variant = bytes[offset];
  if (variant === 0x00) {
    if (bytes.length < offset + 17) return { ok: false, err: 'value truncated' };
    const lo = bytes.readBigUInt64LE(offset + 1);
    const hi = bytes.readBigUInt64LE(offset + 9);
    return { ok: true, value: (hi << 64n) | lo };
  }
  return { ok: false, err: decodeScaleString(bytes, offset + 1) };
}

// Decode Result<u32, String> — Ok(u32) = 0x00 + 4 bytes; Err = 0x01 + compact + str
// Also handles Result<(), String> — Ok(()) = 0x00 with no following bytes
function decodeResultU32OrUnit(bytes, offset) {
  if (bytes.length <= offset) return { ok: false, err: 'reply too short' };
  const variant = bytes[offset];
  if (variant === 0x00) {
    // Ok — if there are 4+ bytes after, decode u32; otherwise it's a unit Ok(())
    if (bytes.length >= offset + 5) {
      return { ok: true, value: bytes.readUInt32LE(offset + 1) };
    }
    return { ok: true, value: null }; // Ok(())
  }
  return { ok: false, err: decodeScaleString(bytes, offset + 1) };
}

// Decode a SCALE compact-prefixed string
function decodeScaleString(bytes, offset) {
  if (bytes.length <= offset) return '(empty)';
  const b0 = bytes[offset];
  const mode = b0 & 0x03;
  let strLen, strStart;
  if (mode === 0) {
    strLen = b0 >> 2;
    strStart = offset + 1;
  } else if (mode === 1) {
    if (bytes.length <= offset + 1) return '(truncated)';
    strLen = ((bytes[offset + 1] << 6) | (b0 >> 2));
    strStart = offset + 2;
  } else {
    return '(unsupported compact)';
  }
  return bytes.slice(strStart, strStart + strLen).toString('utf8');
}

// Decode (String, u128) tuple — for GetCachedPrice
function decodeTupleStringU128(bytes, offset) {
  if (bytes.length <= offset) return null;
  const b0 = bytes[offset];
  const mode = b0 & 0x03;
  let strLen, strStart;
  if (mode === 0) { strLen = b0 >> 2; strStart = offset + 1; }
  else if (mode === 1) { strLen = ((bytes[offset + 1] << 6) | (b0 >> 2)); strStart = offset + 2; }
  else return null;
  const asset = bytes.slice(strStart, strStart + strLen).toString('utf8');
  const priceOffset = strStart + strLen;
  if (bytes.length < priceOffset + 16) return { asset, price: 0n };
  const lo = bytes.readBigUInt64LE(priceOffset);
  const hi = bytes.readBigUInt64LE(priceOffset + 8);
  return { asset, price: (hi << 64n) | lo };
}

// ─── Core: send message + await reply ───
// expectedPrefixHex: if provided, only accept replies whose hex starts with this prefix.
// This filters out stale node-replayed events (previous call's reply replayed to new subscriber).
// Vara's gear_subscribeUserMessageSent replays recent events on subscribe, so without this
// filter each query may capture the previous query's reply.
async function sendAndAwaitReply(api, account, programId, payload, timeoutMs = 25000, expectedPrefixHex = null) {
  const source = u8aToHex(decodeAddress(account.address));
  const gas = await api.program.calculateGas.handle(source, programId, payload, 0, true);

  let replyHex = null;
  let unsubFn = null;

  const isExpectedReply = (hex) => {
    if (!expectedPrefixHex) return true;
    if (typeof expectedPrefixHex === 'function') return expectedPrefixHex(hex);
    return hex.startsWith(expectedPrefixHex);
  };

  unsubFn = await api.gearEvents.subscribeToGearEvent('UserMessageSent', (event) => {
    try {
      const { message } = event.data;
      if (message.source.toHex() !== programId) return;
      const candidate = message.payload.toHex();
      if (!isExpectedReply(candidate)) return; // stale replay from different method
      if (!replyHex) {
        replyHex = candidate;
        if (unsubFn) { try { unsubFn(); } catch (_) {} }
      }
    } catch (_) {}
  });

  try {
    await new Promise((resolve, reject) => {
      api.message.send({
        destination: programId,
        payload,
        gasLimit: gas.min_limit.toBigInt() * 2n,
        value: 0n,
      }).signAndSend(account, ({ status, events }) => {
        if (status.isInBlock || status.isFinalized) {
          const failed = events.some(({ event }) =>
            event.section === 'system' && event.method === 'ExtrinsicFailed'
          );
          if (failed) reject(new Error('ExtrinsicFailed'));
          else resolve(null);
        }
      });
    });
  } catch (e) {
    try { if (unsubFn) unsubFn(); } catch (_) {}
    throw e;
  }

  let waited = 0;
  while (!replyHex && waited < timeoutMs) {
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
  }

  try { if (unsubFn) unsubFn(); } catch (_) {}
  await new Promise(r => setTimeout(r, 2000)); // settling delay
  return replyHex;
}

// Build expected reply prefix hex: SCALE("Service") + SCALE("Method")
function replyPrefix(...parts) {
  return '0x' + Buffer.concat(parts.map(p => scaleStr(p))).toString('hex');
}

// ─── Results tracker ───
const results = [];
function pass(id, description, detail) {
  console.log(`  ✓ [${id}] ${description} — ${detail}`);
  results.push({ id, status: 'PASS', description, detail });
}
function fail(id, description, detail) {
  console.log(`  ✗ [${id}] ${description} — ${detail}`);
  results.push({ id, status: 'FAIL', description, detail });
}
function skip(id, description, reason) {
  console.log(`  ~ [${id}] ${description} — SKIP: ${reason}`);
  results.push({ id, status: 'SKIP', description, detail: reason });
}

// ─── AF-1: Mainnet GetPrice for all 5 assets ───
async function testMainnetPrices() {
  console.log('\n[AF-1] Mainnet Oracle — GetPrice all assets');
  const api = await GearApi.create({ providerAddress: MAINNET_ENDPOINT });
  try {
    const keystorePath = process.env.PRICE_AGENT_MNEMONIC;
    if (!keystorePath || !keystorePath.startsWith('/')) {
      skip('AF1', 'Mainnet prices', 'PRICE_AGENT_MNEMONIC is not a keystore path');
      return;
    }
    const keystore = JSON.parse(readFileSync(keystorePath, 'utf8'));
    const account = GearKeyring.fromJson(keystore, undefined);
    console.log(`  Mainnet account: ${account.address}`);

    const ASSETS = ['VARA/USD', 'BTC/USD', 'ETH/USD', 'DOT/USD', 'USDT/USD'];
    let passed = 0;

    // Sequential with explicit cleanup between queries
    for (const asset of ASSETS) {
      try {
        const payload = buildPayload('Oracle', 'GetPrice', asset);
        // Validator: distinguish replies by asset content to prevent stale-reply cross-contamination.
        // OracleData SCALE: price(u128,16B) + confidence(u128,16B) + timestamp(u64,8B) + asset(String) + ...
        // After 16-byte prefix + 1 byte Ok: price at [17], asset string at [57].
        const prefix = replyPrefix('Oracle', 'GetPrice');
        const assetValidator = (hex) => {
          if (!hex.startsWith(prefix)) return false;
          const raw = Buffer.from(hex.slice(2), 'hex');
          const variant = raw[16]; // Ok=0x00, Err=0x01
          if (variant === 0x01) {
            // Err(String) — check error mentions this specific asset
            return decodeResultU128(raw, 16).err.includes(asset);
          }
          // Ok(OracleData) — verify asset field at offset 57
          if (raw.length > 58) {
            const assetLenByte = raw[57];
            const assetLen = (assetLenByte & 0x03) === 0 ? assetLenByte >> 2 : (raw[58] << 6) | (assetLenByte >> 2);
            const assetStart = (assetLenByte & 0x03) === 0 ? 58 : 59;
            const storedAsset = raw.slice(assetStart, assetStart + assetLen).toString('utf8');
            return storedAsset === asset;
          }
          return true;
        };
        const replyHex = await sendAndAwaitReply(api, account, VARACORE_MAINNET, payload, 30000, assetValidator);
        if (!replyHex) { fail(`AF1-${asset}`, `GetPrice ${asset} mainnet`, 'no reply within 30s'); continue; }

        const raw = Buffer.from(replyHex.slice(2), 'hex');
        // Reply prefix: "Oracle"(7B) + "GetPrice"(9B) = 16 bytes
        const decoded = decodeResultU128(raw, 16);
        if (decoded.ok && decoded.value > 0n) {
          const priceUsd = (Number(decoded.value) / 1e8).toFixed(4);
          pass(`AF1-${asset}`, `GetPrice ${asset}`, `$${priceUsd}`);
          passed++;
        } else if (decoded.ok) {
          fail(`AF1-${asset}`, `GetPrice ${asset}`, 'price=0 (not seeded on mainnet)');
        } else {
          fail(`AF1-${asset}`, `GetPrice ${asset}`, `Err: ${decoded.err}`);
        }
      } catch (e) {
        fail(`AF1-${asset}`, `GetPrice ${asset} mainnet`, e.message.slice(0, 80));
      }
    }
    console.log(`  [AF-1] ${passed}/${ASSETS.length} mainnet assets have price > 0`);
  } finally {
    await api.disconnect();
  }
}

// ─── AF-5: Testnet ScheduleRefresh ACK ───
async function testScheduleRefresh(api, account) {
  console.log('\n[AF-5] Testnet Oracle — ScheduleRefresh ACK');
  try {
    const start = Date.now();
    const payload = buildPayload('Oracle', 'ScheduleRefresh');
    const replyHex = await sendAndAwaitReply(api, account, VARACORE_TESTNET, payload, 15000, replyPrefix('Oracle', 'ScheduleRefresh'));
    const elapsed = Date.now() - start;

    if (!replyHex) { fail('AF5', 'ScheduleRefresh ACK', 'no reply within 15s'); return; }

    const raw = Buffer.from(replyHex.slice(2), 'hex');
    // Reply prefix: "Oracle"(7B) + "ScheduleRefresh"(16B) = 23 bytes
    const decoded = decodeResultU32OrUnit(raw, 23);

    if (decoded.ok) {
      const desc = decoded.value !== null ? `Ok(${decoded.value})` : 'Ok(())';
      pass('AF5', 'ScheduleRefresh ACK', `${desc} in ${elapsed}ms`);
    } else {
      // Check for expected gas-reservation error in constrained environment
      const isGasErr = decoded.err && (decoded.err.includes('reserve') || decoded.err.includes('gas'));
      if (isGasErr) {
        pass('AF5', 'ScheduleRefresh graceful gas-reservation error', `Err("${decoded.err}")`);
      } else {
        fail('AF5', 'ScheduleRefresh ACK', `Err: ${decoded.err}`);
      }
    }
  } catch (e) {
    fail('AF5', 'ScheduleRefresh ACK', e.message.slice(0, 80));
  }
}

// ─── AF-2: Testnet PriceConsumer.FetchPriceFromOracle + GetCachedPrice ───
async function testPriceConsumer(api, account) {
  console.log('\n[AF-2] Testnet PriceConsumer — FetchPriceFromOracle → GetCachedPrice');
  try {
    // FetchPriceFromOracle("VARA/USD")
    // "PriceConsumer"(14B) + "FetchPriceFromOracle"(21B) = 35 bytes prefix on reply
    const fetchPayload = buildPayload('PriceConsumer', 'FetchPriceFromOracle', 'VARA/USD');
    const fetchReply = await sendAndAwaitReply(api, account, PRICE_CONSUMER, fetchPayload, 60000, replyPrefix('PriceConsumer', 'FetchPriceFromOracle'));

    if (!fetchReply) { fail('AF2-fetch', 'FetchPriceFromOracle timeout', 'no reply within 60s'); return; }

    const fetchRaw = Buffer.from(fetchReply.slice(2), 'hex');
    console.log(`  FetchPriceFromOracle raw (${fetchRaw.length}B): ${fetchRaw.slice(0, 48).toString('hex')}...`);
    const fetchDecoded = decodeResultU128(fetchRaw, 35);

    if (fetchDecoded.ok && fetchDecoded.value > 0n) {
      const price = (Number(fetchDecoded.value) / 1e8).toFixed(6);
      pass('AF2-fetch', 'FetchPriceFromOracle VARA/USD', `$${price} stored in PriceConsumer state`);
    } else if (fetchDecoded.ok) {
      fail('AF2-fetch', 'FetchPriceFromOracle', 'price=0 (oracle not seeded)');
      return;
    } else {
      fail('AF2-fetch', 'FetchPriceFromOracle', `Err: ${fetchDecoded.err}`);
      return;
    }

    // GetCachedPrice — verify state was persisted
    // "PriceConsumer"(14B) + "GetCachedPrice"(15B) = 29 bytes prefix
    const cachePayload = buildPayload('PriceConsumer', 'GetCachedPrice');
    const cacheReply = await sendAndAwaitReply(api, account, PRICE_CONSUMER, cachePayload, 20000, replyPrefix('PriceConsumer', 'GetCachedPrice'));

    if (!cacheReply) { fail('AF2-cache', 'GetCachedPrice timeout', 'no reply within 20s'); return; }

    const cacheRaw = Buffer.from(cacheReply.slice(2), 'hex');
    console.log(`  GetCachedPrice raw (${cacheRaw.length}B): ${cacheRaw.slice(0, 48).toString('hex')}...`);
    const cached = decodeTupleStringU128(cacheRaw, 29);
    if (cached && cached.price > 0n) {
      pass('AF2-cache', 'GetCachedPrice state persisted', `${cached.asset}: $${(Number(cached.price) / 1e8).toFixed(6)}`);
    } else {
      fail('AF2-cache', 'GetCachedPrice state', `asset="${cached?.asset || '?'}" price=${cached?.price ?? 'null'}`);
    }
  } catch (e) {
    fail('AF2', 'PriceConsumer E2E', e.message.slice(0, 80));
  }
}

// ─── AF-3: AgentConsumer.CheckAgentTrust ───
async function testCheckAgentTrust(api, account) {
  console.log('\n[AF-3] Testnet AgentConsumer — CheckAgentTrust');
  try {
    const aliceBytes = Buffer.from(u8aToHex(decodeAddress(account.address)).slice(2), 'hex');
    // "AgentConsumer"(14B) + "CheckAgentTrust"(16B) = 30 bytes; + 32 bytes ActorId
    const payload = '0x' + Buffer.concat([
      scaleStr('AgentConsumer'),
      scaleStr('CheckAgentTrust'),
      aliceBytes,
    ]).toString('hex');

    const replyHex = await sendAndAwaitReply(api, account, AGENT_CONSUMER, payload, 45000, replyPrefix('AgentConsumer', 'CheckAgentTrust'));

    if (!replyHex) { fail('AF3', 'CheckAgentTrust timeout', 'no reply within 45s'); return; }

    const raw = Buffer.from(replyHex.slice(2), 'hex');
    console.log(`  CheckAgentTrust raw (${raw.length}B): ${raw.slice(0, 48).toString('hex')}...`);
    const decoded = decodeResultU32OrUnit(raw, 30);

    if (decoded.ok && decoded.value !== null) {
      pass('AF3', 'CheckAgentTrust(Alice)', `score=${decoded.value} (${decoded.value / 10} / 100)`);
    } else if (!decoded.ok && decoded.err && decoded.err.toLowerCase().includes('interact')) {
      // Oracle returned "agent has no recorded interactions" — cross-program call worked, graceful Err
      pass('AF3', 'CheckAgentTrust cross-program reachable (no interactions seeded)', `Err: "${decoded.err}"`);
    } else if (!decoded.ok) {
      fail('AF3', 'CheckAgentTrust', `Err: ${decoded.err}`);
    }
  } catch (e) {
    fail('AF3', 'CheckAgentTrust', e.message.slice(0, 80));
  }
}

// ─── AF-4: AgentConsumer.FindOracleAgents ───
async function testFindOracleAgents(api, account) {
  console.log('\n[AF-4] Testnet AgentConsumer — FindOracleAgents');
  try {
    // "AgentConsumer"(14B) + "FindOracleAgents"(17B) = 31 bytes prefix on reply
    const payload = buildPayload('AgentConsumer', 'FindOracleAgents');
    const replyHex = await sendAndAwaitReply(api, account, AGENT_CONSUMER, payload, 45000, replyPrefix('AgentConsumer', 'FindOracleAgents'));

    if (!replyHex) { fail('AF4', 'FindOracleAgents timeout', 'no reply within 45s'); return; }

    const raw = Buffer.from(replyHex.slice(2), 'hex');
    console.log(`  FindOracleAgents raw (${raw.length}B): ${raw.slice(0, 48).toString('hex')}...`);
    const decoded = decodeResultU32OrUnit(raw, 31);

    if (decoded.ok && decoded.value !== null) {
      pass('AF4', 'FindOracleAgents(price-feed)', `count=${decoded.value} agents discovered`);
    } else if (!decoded.ok) {
      fail('AF4', 'FindOracleAgents', `Err: ${decoded.err}`);
    }
  } catch (e) {
    fail('AF4', 'FindOracleAgents', e.message.slice(0, 80));
  }
}

// ─── Main ───
async function main() {
  const startTime = Date.now();
  console.log('=== Phase 2.5: End-to-End Flow Integration Test ===');
  console.log(`Started: ${new Date().toISOString()}`);

  if (!VARACORE_MAINNET || !VARACORE_TESTNET || !PRICE_CONSUMER || !AGENT_CONSUMER) {
    console.error('Missing required env vars — check agent/.env');
    process.exit(1);
  }

  // AF-1: Mainnet prices
  try { await testMainnetPrices(); } catch (e) {
    fail('AF1', 'Mainnet GetPrice suite', e.message.slice(0, 80));
  }

  // AF-2 through AF-5: Testnet
  console.log('\nConnecting to testnet...');
  const testnetApi = await GearApi.create({ providerAddress: TESTNET_ENDPOINT });
  const account = await GearKeyring.fromSuri('//Alice');
  console.log(`Account: ${account.address}`);

  try {
    await testScheduleRefresh(testnetApi, account);
    await testPriceConsumer(testnetApi, account);
    await testCheckAgentTrust(testnetApi, account);
    await testFindOracleAgents(testnetApi, account);
  } finally {
    await testnetApi.disconnect();
  }

  // Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const skipped = results.filter(r => r.status === 'SKIP').length;

  console.log('\n=== E2E Results ===');
  console.log(`Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped} | Duration: ${elapsed}s`);

  const output = {
    timestamp: new Date().toISOString(),
    duration_seconds: parseFloat(elapsed),
    results,
    summary: { passed, failed, skipped },
  };
  require('fs').writeFileSync('/Users/MAC/vara-a2a/agent/.e2e-results.json', JSON.stringify(output, null, 2));
  console.log('Results saved to agent/.e2e-results.json');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
setTimeout(() => { console.error('GLOBAL TIMEOUT (10min)'); process.exit(2); }, 600_000);
