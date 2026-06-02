# VaraCore — Full Senior-Dev Critique Findings
# Generated: 2026-06-02

---

## RATINGS SUMMARY

| Component | Score | Critical Issues |
|-----------|-------|----------------|
| OracleService (oracle.rs) | 7.5/10 | USDT always Degraded; ScheduleRefresh no auth; loop decoupled from prices |
| ReputationService (reputation.rs) | 6.5/10 | success_rate_bps u64 overflow; Sybil trivially exploitable; days_active grows with inactivity |
| RegistryService (registry.rs) | 7.0/10 | No hub_handle uniqueness; no length validation on handle/hint; silent description truncation |
| lib.rs (wiring) | 9.0/10 | Lifetime elision warnings only (cosmetic) |
| price-agent.ts | 7.0/10 | Wrong default endpoint (testnet); single timestamp for 5 assets; no stale alert |
| seed-interactions.ts | 5.0/10 | GearKeyring.fromMnemonic breaks when MNEMONIC is a file path; fake data masquerades as provenance |
| register-test-agents.ts | 7.0/10 | Same fromMnemonic/JSON path bug as seed-interactions |
| PriceConsumer | 7.0/10 | Stale prices pass silently; cached price has no timestamp; no default oracle address in constructor |
| AgentConsumer | 7.0/10 | find_oracle_agents hardcodes "price-feed"; Ok(0) ambiguous; picks first agent blindly |
| E2E / Integration | 7.0/10 | ScheduleRefresh decoupled from prices; single operator key; no events; USDT/USD dead in practice |
| **OVERALL** | **7.1/10** | |

---

## ORACLE SERVICE (oracle.rs)

### Working Correctly
- get_price and get_multiple_prices both apply stale override at query time — consistent
- update_price validates zero price, sanity upper bound (1e18), timestamp not >60s future, source_count >= 1, asset in supported list
- TWAP ring arithmetic correct — arithmetic mean doesn't depend on slot order, so wrapping is safe
- schedule_refresh proven running on mainnet (two sequential self-calls on-chain)

### Bugs and Gaps

**O-USDT: USDT/USD always FeedStatus::Degraded** (high severity, silent failure for consumers)
price-agent.ts uses only CoinGecko for USDT: sourcesByAsset['USDT/USD'] = [coingecko].
filtered.length = 1 always → source_count = 1 → FeedStatus::Degraded on every UpdatePrice.
PriceConsumer rejects Degraded. USDT/USD exists on chain but is unusable via the consumer path.

**O-AUTH: ScheduleRefresh has no msg::source() check** (resource drain risk)
Any caller can invoke ScheduleRefresh. Each call reserves 5B gas for 200 blocks and enqueues
a delayed self-message. Attacker can spawn many parallel loops, draining the program's gas
balance. Documented as O-9, accepted for v3.

**O-DECOUPLE: ScheduleRefresh loop does not update prices** (conceptual mismatch in docs)
The loop only schedules the next loop invocation. Prices are exclusively updated by the
off-chain price-agent TypeScript process. If that process dies, prices go stale on-chain
while the loop continues firing healthy-looking self-calls. These two systems are fully
decoupled with no interaction.

**O-PERM: UpdatePrice is permissionless with caller-reported source_count** (manipulation)
Any account can call UpdatePrice with arbitrary values. source_count is not verified on-chain.
An attacker submitting 8 consecutive calls can rotate the entire TWAP ring with fabricated
prices. No rate limiting, no minimum inter-submission delay, no stake requirement.

---

## REPUTATION SERVICE (reputation.rs)

### Working Correctly
- VecDeque with pop_front() — O(1) eviction (R-5)
- Inactivity cap: blocks > 864000 → raw score capped at 50 (R-1)
- floor_log2 tested at all boundary values
- decay_scores documented no-op, IDL-retained

### Bugs and Gaps

**R-OVERFLOW: success_rate_bps multiplication overflows u64** (latent bug)
  (self.successful_interactions * 10_000) / self.total_interactions
At successful_interactions = u64::MAX / 10_000 (~1.84e15), the multiplication overflows
before the division. Fix: use saturating_mul(10_000).

**R-SYBIL: Zero Sybil resistance** (design-level gap, v3 roadmap)
Any wallet can call RecordInteraction(victim, success=true) unlimited times.
~256 calls = 900/1000 score. Cost: ~256 * 5B gas. No per-caller rate limit, no stake,
no cooldown.

**R-ACTIVITY: days_active computed from first_active_block, not last_active_block**
An agent registered 200 days ago with 1 interaction still accrues c3 longevity credit
from those 200 days. The R-1 inactivity cap (>30 days → cap 500) partially compensates
but doesn't eliminate the issue. days_active should use last_active_block for accuracy.

**R-GAS: get_top_agents is O(n) scan + sort** — no gas guard at large n.

**R-SILENT: get_interaction_history limit > 50 returns 50 silently** — no indication to caller.

---

## REGISTRY SERVICE (registry.rs)

### Working Correctly
- get_agent recomputes is_active from exec::block_height() at query time (Reg-E)
- update_agent applies endpoint_hint from AgentUpdate (Reg-C) — fixed this session
- endpoint_hint field added to AgentListing struct and initialized from AgentRegistration
- get_agents_by_capability recomputes and filters inactive agents (Reg-1)
- AgentListingReply in agent-consumer updated to include endpoint_hint

### Bugs and Gaps

**Reg-UNIQUE: No unique hub_handle enforcement**
Two agents can register with identical hub_handle strings. Discovery returns both.
No deduplication or collision detection.

**Reg-LEN: hub_handle and endpoint_hint have no length validation**
Description is truncated at 512 chars. hub_handle and endpoint_hint accept unlimited length.
A malicious registration could store megabytes per entry.

**Reg-SILENT: register_agent silently truncates description**
Returns Ok(()) even when 1024-char description was cut to 512. Caller cannot know.

**Reg-DOUBLE: update_agent capabilities does two map lookups unnecessarily**
After deindex, re-fetches state.agents.get_mut() instead of reusing the original listing
reference. Works correctly (NLL releases the borrow at last use of listing), but wasteful.

---

## lib.rs (wiring)

**9.0/10 — Clean.**
Accessor names correctly determine sails-rs routing strings: oracle()→"Oracle",
reputation()→"Reputation", registry()→"Registry". Three independent RefCell<State>
instances. #[program] macro correct. Lifetime elision warnings are cosmetic only.

---

## price-agent.ts

### Working Correctly
- Promise.allSettled for parallel fetching — one failure doesn't abort
- Outlier rejection at ±5% of median — correct math
- Double-median aggregation correct
- SCALE compact encoding correct for all practical lengths
- u128 little-endian encoding correct
- Supports mnemonic strings AND JSON keystore file paths
- 2-retry + WebSocket reconnect logic

### Bugs and Gaps

**PA-ENDPOINT: Default endpoint is testnet** (silent misconfiguration)
const VARA_ENDPOINT = process.env.VARA_ENDPOINT || 'wss://rpc.vara-network.io';
The mainnet URL is 'wss://rpc.vara.network'. If VARA_ENDPOINT is not explicitly set,
the agent silently connects to testnet and submits to the wrong program.

**PA-TS: Single timestamp for all 5 sequential submissions**
now = BigInt(Math.floor(Date.now() / 1000)) is computed once. The 5th asset is
submitted seconds later but carries the same timestamp as the 1st.

**PA-CAST: WebSocket reconnect uses `any` casting**
(api.provider as any).on('disconnected') — breaks silently if @gear-js/api internals change.

**PA-ALERT: No alerting on consecutive failures**
If all sources fail for N consecutive runs, there is no alert mechanism. The agent
logs errors and continues. Prices go stale with no notification.

**PA-DEAD: withRetry has dead throw at end** — unreachable code after for-loop handles all retries.

---

## seed-interactions.ts

### Bugs

**SEED-KEY: GearKeyring.fromMnemonic fails when MNEMONIC is a file path** (broken in production)
price-agent.ts has the path-check:
  PRICE_AGENT_MNEMONIC.startsWith('/') ? GearKeyring.fromJson(...) : fromMnemonic(...)
seed-interactions.ts calls fromMnemonic unconditionally. With PRICE_AGENT_MNEMONIC=/path/...,
this throws. The entire seeder script is broken in production config.
register-test-agents.ts has the same bug.

**SEED-FAKE: Seeds fabricated interaction strings for real deployed addresses**
PRICE_CONSUMER_ID and AGENT_CONSUMER_ID are real on-chain programs seeded with
strings like "DiscoverAgents returned 3 oracle agents" — fake provenance that looks
real to judges reading reputation history.

**SEED-IDEM: No idempotency** — running twice doubles all interaction counts.

---

## PriceConsumer (price-consumer/src/lib.rs)

### Working Correctly
- Degraded gate rejects single-source prices
- PREFIX = 16 bytes correct ("Oracle"=7 + "GetPrice"=9)
- set_oracle_address is owner-gated
- reply_deposit = 50_000_000_000 — correct

### Gaps

**PC-STALE: Stale prices pass through silently**
The Degraded gate exists but FeedStatus::Stale prices return Ok(price) with no warning.
Caller receives a stale price with no freshness signal. fetch_price_from_oracle returns
u128 only — the status information is thrown away.

**PC-CACHE: get_cached_price returns no timestamp**
Cached price from 5 hours ago is indistinguishable from a 5-second-old one.

**PC-DEFAULT: No hardcoded default oracle address in constructor**
Requires set_oracle_address call before any fetch can succeed. Constructor could
pre-populate with the known VaraCore mainnet PID.

---

## AgentConsumer (agent-consumer/src/lib.rs)

### Working Correctly
- Trust gate: MIN_TRUST_SCORE = 400 enforced
- AgentListingReply includes endpoint_hint — fixed to match on-chain struct
- Decode error properly propagated (no more unwrap_or_default)
- PREFIX constants correct (22 for ScoreAgent, 31 for GetAgentsByCapability)
- reply_deposit = 50_000_000_000 — correct

### Gaps

**AC-HARD: find_oracle_agents hardcodes "price-feed" capability** — not configurable.

**AC-AMBIG: Returns Ok(0) when no agents found** — ambiguous success/failure signal.

**AC-BLIND: Caches hub_handle of first agent in Vec with no trust filter**
Discovery returns a Vec sorted by registration time (BTreeMap key order = ActorId bytes).
The "first" agent is the one with the lowest ActorId bytes — not the most trusted one.

---

## E2E Workflow

### Proven Working On-Chain
| Path | Status |
|------|--------|
| price-agent → UpdatePrice | VERIFIED (93 mainnet assertions) |
| ScheduleRefresh self-loop | VERIFIED (two sequential self-calls, block hashes in proof.md) |
| PriceConsumer → GetPrice | VERIFIED (block hash in proof.md) |
| AgentConsumer → ScoreAgent | VERIFIED |
| AgentConsumer → GetAgentsByCapability | VERIFIED |
| Registry self-registration | VERIFIED (block 33458098) |

### Architecture Gaps

**E2E-DECOUPLE: ScheduleRefresh and price freshness are fully decoupled**
Off-chain agent going offline → prices stale. Loop keeps firing. Chain looks healthy.

**E2E-KEY: Single operator key controls everything**
All UpdatePrice, RegisterAgent, RecordInteraction, SetOracleAddress, SetVaracoreAddress
calls come from one wallet. Key compromise = full system compromise.

**E2E-EVENTS: No events on any state change**
No subscription model. All integrations must poll. Major DX gap for real integrators.

**E2E-USDT: USDT/USD architecturally dead**
In supported list, submitted with Degraded status always, rejected by consumer.
