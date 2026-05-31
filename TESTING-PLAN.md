# VaraCore Testing Plan — V1: Foundation
**Version:** 1.0
**Date:** 2026-05-31
**Scope:** All 18 service methods across OracleService, ReputationService, AgentRegistryService, PriceConsumer, AgentConsumer
**Approach:** Suite-based. Happy path for every method + immediate first-level error paths. No deep state sequences — those are in V2.
**Goal:** Confirm every exported method responds correctly under normal operation. Nothing skipped.

---

## Environment

| Item | Value |
|------|-------|
| Network | `wss://rpc.vara-network.io` (Vara mainnet) |
| VaraCore | `0xe1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078` |
| PriceConsumer | `0xc6836012147737b2e610677403845cc9decb55c75c5488b547278f3cd5554d1a` |
| AgentConsumer | `0xc12b0063953adb7b40ed6f01521b9b0e861d7361b6eb0739cdea573e3ca2349b` |
| Wallet | `varacore-operator.json` (passphrase: empty) |
| Test runner | `agent/src/livetest-mainnet.ts` (or direct IDEA portal calls) |

## SCALE Routing Reference
All method payloads use SCALE-encoded service/method prefix:
- Oracle calls: prefix = `"Oracle"` (7 bytes) + `"MethodName"` (n bytes)
- Reputation calls: prefix = `"Reputation"` (11 bytes) + `"MethodName"` (n bytes)
- Registry calls: prefix = `"Registry"` (9 bytes) + `"MethodName"` (n bytes)

Note: IDL shows `service AgentRegistry` but the on-chain routing prefix is `"Registry"` (derived from the `registry()` accessor fn name).

---

## Suite OC — OracleService.UpdatePrice (12 cases)

**Signature:** `UpdatePrice(asset: str, price: u128, confidence: u128, timestamp: u64, source_count: u32) -> result(null, str)`

**TC-OC-01: Happy path — Fresh status**
- Action: Call `Oracle.UpdatePrice`
- Input: `("BTC/USD", 7_540_000_000_000, 50_000_000_000, <current_unix_ts>, 3)`
- Expected: `Ok(())`
- Verify: Call `Oracle.GetPrice("BTC/USD")` → `Ok(OracleData { price: 7_540_000_000_000, confidence: 50_000_000_000, asset: "BTC/USD", source_count: 3, status: Fresh })`

**TC-OC-02: Happy path — Degraded status**
- Action: Call `Oracle.UpdatePrice`
- Input: `("VARA/USD", 6_700_000, 500_000, <current_unix_ts>, 1)`
- Expected: `Ok(())`
- Verify: Call `Oracle.GetPrice("VARA/USD")` → `status: Degraded`

**TC-OC-03: Overwrite existing price**
- Action: UpdatePrice BTC/USD with price A, then immediately UpdatePrice BTC/USD with price B
- Input A: `("BTC/USD", 1_000_000_000, 0, <ts>, 2)` → `Ok`
- Input B: `("BTC/USD", 2_000_000_000, 100_000, <ts+1>, 3)` → `Ok`
- Verify: GetPrice("BTC/USD") → price=2_000_000_000 (price B wins, not A)

**TC-OC-04: All 5 supported assets succeed**
- Action: Call UpdatePrice for each of the 5 supported assets in sequence
- Inputs:
  - `("VARA/USD", 6_700_000, 100_000, <ts>, 2)` → `Ok`
  - `("BTC/USD", 7_540_000_000_000, 5_000_000_000, <ts>, 3)` → `Ok`
  - `("ETH/USD", 210_000_000_000, 2_000_000_000, <ts>, 3)` → `Ok`
  - `("DOT/USD", 122_000_000, 1_000_000, <ts>, 2)` → `Ok`
  - `("USDT/USD", 99_990_000, 10_000, <ts>, 2)` → `Ok`
- Verify: GetSupportedAssets returns 5; all 5 GetPrice calls return Ok

**TC-OC-05: Err — unsupported asset**
- Input: `("XRP/USD", 100_000_000, 0, <ts>, 2)`
- Expected: `Err("unsupported asset 'XRP/USD'")`
- Verify: Error message contains "unsupported asset"

**TC-OC-06: Err — price = 0**
- Input: `("BTC/USD", 0, 0, <ts>, 2)`
- Expected: `Err("price must be non-zero")`

**TC-OC-07: Err — source_count = 0**
- Input: `("BTC/USD", 1_000_000_000, 0, <ts>, 0)`
- Expected: `Err("source_count must be >= 1")`

**TC-OC-08: Valid — confidence = 0 (no check on confidence)**
- Input: `("ETH/USD", 210_000_000_000, 0, <ts>, 2)`
- Expected: `Ok(())`
- Verify: GetPrice("ETH/USD") → confidence = 0, status = Fresh

**TC-OC-09: Valid — confidence > price**
- Input: `("DOT/USD", 50_000_000, 999_999_999_999, <ts>, 2)`
- Expected: `Ok(())` (no validation on confidence vs price ratio)
- Verify: GetPrice("DOT/USD") → confidence = 999_999_999_999

**TC-OC-10: Valid — timestamp = 0**
- Input: `("USDT/USD", 100_000_000, 0, 0, 2)`
- Expected: `Ok(())` (no timestamp validation on input)
- Verify: GetPrice("USDT/USD") → timestamp = 0

**TC-OC-11: Valid — source_count = u32::MAX (4_294_967_295)**
- Input: `("BTC/USD", 1_000_000_000, 0, <ts>, 4_294_967_295)`
- Expected: `Ok(())` → status = Fresh (any source_count >= 2 → Fresh)
- Verify: GetPrice("BTC/USD") → source_count = 4294967295, status = Fresh

**TC-OC-12: Valid — price = 1 (minimum non-zero)**
- Input: `("VARA/USD", 1, 0, <ts>, 2)`
- Expected: `Ok(())` (price=1 is valid — only price=0 is rejected)
- Verify: GetPrice("VARA/USD") → price = 1

---

## Suite OQ — OracleService Read Queries (10 cases)

**TC-OQ-01: GetPrice — known asset returns all 6 fields**
- Precondition: BTC/USD has been updated (run TC-OC-01)
- Action: `Oracle.GetPrice("BTC/USD")`
- Expected: `Ok(OracleData)` with all 6 fields populated:
  - `price: u128` (non-zero)
  - `confidence: u128`
  - `timestamp: u64`
  - `asset: "BTC/USD"`
  - `source_count: u32`
  - `status: Fresh | Degraded` (never Stale — Stale variant exists in code but UpdatePrice never sets it)

**TC-OQ-02: GetPrice — never-updated asset returns Err**
- Action: `Oracle.GetPrice("ETH/USD")` on a fresh program (or use an asset that was never updated in this session)
- Expected: `Err("asset 'ETH/USD' not registered or not yet updated")`

**TC-OQ-03: GetPrice — unsupported asset name returns Err**
- Action: `Oracle.GetPrice("FAKE/USD")`
- Expected: `Err("asset 'FAKE/USD' not registered or not yet updated")` (same error — no special case for unsupported vs unset)

**TC-OQ-04: GetMultiplePrices — all 5 assets, all Ok**
- Precondition: All 5 assets updated (run TC-OC-04)
- Action: `Oracle.GetMultiplePrices(["VARA/USD","BTC/USD","ETH/USD","DOT/USD","USDT/USD"])`
- Expected: Vec of 5 `Ok(OracleData)` — order matches input order

**TC-OQ-05: GetMultiplePrices — mix of known and unknown**
- Action: `Oracle.GetMultiplePrices(["BTC/USD","UNKNOWN/USD","ETH/USD"])`
- Expected: `[Ok(OracleData{BTC/USD}), Err("asset 'UNKNOWN/USD' not found"), Ok(OracleData{ETH/USD})]`
- Verify: Length = 3; index 0 is Ok; index 1 is Err; index 2 is Ok

**TC-OQ-06: GetMultiplePrices — all unknown assets**
- Action: `Oracle.GetMultiplePrices(["X/Y","A/B"])`
- Expected: `[Err("asset 'X/Y' not found"), Err("asset 'A/B' not found")]`

**TC-OQ-07: GetMultiplePrices — empty input**
- Action: `Oracle.GetMultiplePrices([])`
- Expected: `[]` (empty Vec)

**TC-OQ-08: GetSupportedAssets — exact list**
- Action: `Oracle.GetSupportedAssets()`
- Expected: `["VARA/USD","BTC/USD","ETH/USD","DOT/USD","USDT/USD"]` (exactly these 5, this order)
- Verify: length = 5; all 5 strings present; no duplicates; case-sensitive match

**TC-OQ-09: GetPrice field accuracy — verify all values match what was submitted**
- Action: UpdatePrice with exact known values, then GetPrice
- Input: `("BTC/USD", 123_456_789, 9_876_543, 1_748_000_000, 2)`
- Expected GetPrice response: `price=123456789, confidence=9876543, timestamp=1748000000, asset="BTC/USD", source_count=2, status=Degraded`

**TC-OQ-10: IsStale — unknown asset always returns true**
- Action: `Oracle.IsStale("NEVERUPDATED/USD", 9999999)`
- Expected: `true` (unknown asset is considered stale regardless of max_age_seconds)

---

## Suite OS — OracleService: IsStale (fresh) + ScheduleRefresh + TWAP (6 cases)

**TC-OS-01: IsStale — fresh asset with generous max_age**
- Precondition: Just called UpdatePrice("BTC/USD", ..., timestamp=<current_unix_ts>)
- Action: `Oracle.IsStale("BTC/USD", 86400)` (24 hours)
- Expected: `false` (just updated, well within 24h window)

**TC-OS-02: IsStale — fresh asset with max_age=0**
- Action: `Oracle.IsStale("BTC/USD", 0)` after recent update
- Expected: Depends on block timestamp vs submitted timestamp. If current_block_ts_seconds > data.timestamp → `true`. In practice current block timestamp ≥ submitted timestamp, so this will almost always be `true`.
- Note: The IsStale boundary is `current_approx_ts - data.timestamp > max_age_seconds` (strict greater-than), so if equal: NOT stale.

**TC-OS-03: IsStale — stale asset with small max_age**
- Action: Update USDT/USD with timestamp=0 (far in the past), then `Oracle.IsStale("USDT/USD", 60)`
- Expected: `true` (timestamp=0 means the delta is huge, > 60 seconds)

**TC-OS-04: ScheduleRefresh — returns Ok**
- Action: `Oracle.ScheduleRefresh()`
- Expected: `Ok(())` (gas reservation succeeds, delayed message queued)
- Verify: Transaction finalizes without ExtrinsicFailed; no Err in reply

**TC-OS-05: TWAP ring — multiple UpdatePrice calls succeed sequentially**
- Action: Call UpdatePrice("BTC/USD") 3 times with different prices
  - Call 1: price=1_000_000_000
  - Call 2: price=2_000_000_000
  - Call 3: price=3_000_000_000
- Expected: All 3 calls return `Ok(())` (ring buffer accepts them)
- Verify: Final GetPrice("BTC/USD") shows price=3_000_000_000 (latest wins for price field)
- Note: Internal TWAP after 3 pushes = (1B + 2B + 3B) / 3 = 2_000_000_000 (not exposed via IDL)

**TC-OS-06: TWAP ring — 8+ calls complete without error (full ring fill + wrap)**
- Action: Call UpdatePrice("ETH/USD") 10 times consecutively
  - Prices: [100,200,300,400,500,600,700,800,900,1000] (×1e6 for u128 units)
- Expected: All 10 calls return `Ok(())` (ring wraps at 8 without error)
- Verify: Final GetPrice("ETH/USD") → price = 1000×1e6 (latest price)
- Internal verification (code review): After 10 pushes of [100..1000], ring contains [900,1000,300,400,500,600,700,800] in slots 0..7. TWAP = (900+1000+300+400+500+600+700+800)/8 = 5200/8 = 650. Not directly queryable.

---

## Suite RC — ReputationService Commands (8 cases)

**Signature:** `RecordInteraction(agent_id: actor_id, success: bool, context: str) -> result(null, str)`

**TC-RC-01: RecordInteraction — happy path, success=true**
- Input: `(agent_id=<any valid ActorId>, success=true, context="test interaction")`
- Expected: `Ok(())`
- Verify: `Reputation.ScoreAgent(<agent_id>)` → `Ok(ReputationData { total_interactions: 1, success_rate_bps: 10000, score: 500 })`

**TC-RC-02: RecordInteraction — success=false**
- Input: `(<agent_id>, false, "failed attempt")`
- Expected: `Ok(())`
- Verify: ScoreAgent → `total_interactions: 1, success_rate_bps: 0, score: 100`

**TC-RC-03: RecordInteraction — context exactly 256 chars (boundary, no truncation)**
- Input: `(<agent_id>, true, "A"×256)` (256 'A' characters)
- Expected: `Ok(())`
- Verify: `GetInteractionHistory(<agent_id>, 1)[0].context.length == 256`

**TC-RC-04: RecordInteraction — context 257 chars (truncated to 256)**
- Input: `(<agent_id>, true, "A"×257)`
- Expected: `Ok(())` (no error — truncation is silent)
- Verify: `GetInteractionHistory(<agent_id>, 1)[0].context.length == 256` (last char dropped)

**TC-RC-05: RecordInteraction — empty context (valid)**
- Input: `(<agent_id>, true, "")`
- Expected: `Ok(())`
- Verify: `GetInteractionHistory(<agent_id>, 1)[0].context == ""`

**TC-RC-06: RecordInteraction — multiple callers for same agent_id**
- Action: Two different wallets record interactions for the same agent_id
- Both: `Ok(())`
- Verify: `ScoreAgent(<agent_id>)` → `total_interactions: 2, success_rate_bps: 10000`
- Note: `caller` field in InteractionRecord differs per wallet (msg::source())

**TC-RC-07: RecordInteraction — same agent called multiple times builds history**
- Action: Call RecordInteraction for same agent_id 5 times (all success=true)
- Verify: ScoreAgent → `total_interactions: 5, score: 600`
  - score=600: c1=(10000×40)/10000=40, c2=floor_log2(5)×5=2×5=10, c3=0, c4=10 → raw=60 → score=600

**TC-RC-08: DecayScores — no-op, always Ok**
- Action: `Reputation.DecayScores()`
- Expected: `Ok(())`
- Verify: Call ScoreAgent before and after DecayScores → score identical (no change applied)

---

## Suite RQ — ReputationService Queries (8 cases)

**TC-RQ-01: ScoreAgent — agent with no interactions returns Err**
- Action: `Reputation.ScoreAgent(<never-interacted ActorId>)`
- Expected: `Err("agent has no recorded interactions")`

**TC-RQ-02: ScoreAgent — 1 success → score 500**
- Precondition: RecordInteraction(agent, success=true) once
- Action: `Reputation.ScoreAgent(agent)`
- Expected: `Ok(ReputationData { total_interactions: 1, success_rate_bps: 10000, score: 500 })`
- Note: days_active=0 (same block), c3=0; c1=40, c2=0, c3=0, c4=10 → raw=50 → score=500

**TC-RQ-03: ScoreAgent — 1 failure → score 100**
- Precondition: RecordInteraction(agent, success=false) once
- Action: `Reputation.ScoreAgent(agent)`
- Expected: `Ok(ReputationData { total_interactions: 1, success_rate_bps: 0, score: 100 })`
- Note: c1=0, c2=0, c3=0, c4=10 → raw=10 → score=100

**TC-RQ-04: ScoreAgent — returned fields**
- Verify all 5 fields are present: `total_interactions: u64, success_rate_bps: u16, days_active: u32, last_active_block: u32, score: u32`

**TC-RQ-05: GetTopAgents — empty state returns empty list**
- Action: `Reputation.GetTopAgents(10)` (if no interactions have been recorded in this session)
- Expected: `[]` (empty Vec)
- Note: On mainnet, prior session interactions exist — expect non-empty list

**TC-RQ-06: GetTopAgents — limit cap at 100**
- Action: `Reputation.GetTopAgents(200)`
- Expected: At most 100 results (even if >100 agents have been scored)

**TC-RQ-07: GetTopAgents — results sorted by score descending**
- Precondition: Two agents A (score=600) and B (score=500)
- Action: `Reputation.GetTopAgents(10)`
- Expected: Agent A appears before agent B in the result list

**TC-RQ-08: GetInteractionHistory — returns empty for unknown agent**
- Action: `Reputation.GetInteractionHistory(<unknown ActorId>, 10)`
- Expected: `[]` (empty Vec, no Err)

---

## Suite GC — AgentRegistryService Commands (10 cases)

**TC-GC-01: RegisterAgent — happy path**
- Caller: `varacore-operator` wallet
- Input:
  ```
  AgentRegistration {
    hub_handle: "test-oracle-agent",
    capabilities: ["price-feed", "twap"],
    service_type: Oracle,
    description: "Test oracle agent",
    endpoint_hint: "wss://example.com"
  }
  ```
- Expected: `Ok(())`
- Verify: `GetAgent(<operator ActorId>)` → returns matching AgentListing

**TC-GC-02: RegisterAgent — Err if hub_handle empty**
- Input: `AgentRegistration { hub_handle: "", capabilities: [], service_type: Other, description: "", endpoint_hint: "" }`
- Expected: `Err("hub_handle must not be empty")`

**TC-GC-03: RegisterAgent — Err if capabilities > 20**
- Input: capabilities = ["cap1", "cap2", ..., "cap21"] (21 items)
- Expected: `Err("max 20 capabilities allowed")`

**TC-GC-04: RegisterAgent — exactly 20 capabilities succeeds**
- Input: capabilities = ["cap1" through "cap20"] (exactly 20)
- Expected: `Ok(())`

**TC-GC-05: RegisterAgent — description truncated to 512 chars silently**
- Input: description = "X"×600 (600 chars)
- Expected: `Ok(())` (no error — truncation is silent)
- Verify: `GetAgent(<id>).description.length == 512`

**TC-GC-06: UpdateAgent — self-update succeeds**
- Precondition: Agent registered (TC-GC-01)
- Action: Caller = agent's own wallet
  ```
  UpdateAgent(<own_id>, AgentUpdate { hub_handle: Some("updated-handle"), capabilities: None, description: None, endpoint_hint: None })
  ```
- Expected: `Ok(())`
- Verify: `GetAgent` → `hub_handle == "updated-handle"`, other fields unchanged

**TC-GC-07: UpdateAgent — Err if caller ≠ agent_id**
- Action: Wallet A calls `UpdateAgent(<wallet_B_id>, ...)`
- Expected: `Err("only the agent itself can update its listing")`

**TC-GC-08: HeartbeatAgent — self-heartbeat succeeds**
- Precondition: Agent registered
- Action: `HeartbeatAgent(<own_id>)` from own wallet
- Expected: `Ok(())`
- Verify: `GetAgent` → `last_heartbeat_block` updated to current block; `is_active == true`

**TC-GC-09: HeartbeatAgent — Err if caller ≠ agent_id**
- Action: Wallet A calls `HeartbeatAgent(<wallet_B_id>)`
- Expected: `Err("only the agent itself can send a heartbeat")`

**TC-GC-10: DelistAgent — removes agent from registry**
- Precondition: Agent registered
- Action: `DelistAgent(<own_id>)` from own wallet
- Expected: `Ok(())`
- Verify: `GetAgent(<own_id>)` → `Err("agent ... not found in registry")`

---

## Suite GQ — AgentRegistryService Queries (8 cases)

**TC-GQ-01: GetAgent — registered agent returns AgentListing**
- Precondition: Register agent (TC-GC-01)
- Action: `AgentRegistry.GetAgent(<agent_ActorId>)`
- Expected: `Ok(AgentListing)` with all 8 fields:
  - `agent_id, hub_handle, capabilities, service_type, description, registered_at_block, last_heartbeat_block, is_active`

**TC-GQ-02: GetAgent — unknown agent returns Err**
- Action: `AgentRegistry.GetAgent(<never-registered ActorId>)`
- Expected: `Err("agent 0x... not found in registry")`

**TC-GQ-03: DiscoverAgents — no filter returns all registered agents**
- Action: `AgentRegistry.DiscoverAgents({ service_type: None, capability: None, active_only: false })`
- Expected: Vec of all registered AgentListings (length ≥ count of registered agents in session)

**TC-GQ-04: DiscoverAgents — filter by service_type**
- Precondition: Register one Oracle agent and one DeFi agent
- Action: `DiscoverAgents({ service_type: Some(Oracle), capability: None, active_only: false })`
- Expected: Only Oracle agents in result; DeFi agent excluded

**TC-GQ-05: DiscoverAgents — filter by capability**
- Precondition: Agent A has ["price-feed", "twap"], Agent B has ["reputation"]
- Action: `DiscoverAgents({ service_type: None, capability: Some("price-feed"), active_only: false })`
- Expected: Agent A in result, Agent B excluded

**TC-GQ-06: DiscoverAgents — active_only=true returns only recently heartbeated agents**
- Precondition: Register agent (last_heartbeat = registration block = current block)
- Action: `DiscoverAgents({ service_type: None, capability: None, active_only: true })`
- Expected: Just-registered agent appears (heartbeat within 1000 blocks)
- Note: is_active = current_block - last_heartbeat_block < 1000

**TC-GQ-07: GetAgentsByCapability — returns agents with that capability**
- Precondition: Agent registered with capability "price-feed"
- Action: `AgentRegistry.GetAgentsByCapability("price-feed")`
- Expected: Vec containing at least that agent
- Note: Returns ALL agents with capability, regardless of active status (no active_only filter here)

**TC-GQ-08: GetAgentsByCapability — unknown capability returns empty Vec (not Err)**
- Action: `AgentRegistry.GetAgentsByCapability("nonexistent-capability")`
- Expected: `[]` (empty Vec, no Err)

---

## Suite PC — PriceConsumer (6 cases)

**Program:** `0xc6836012147737b2e610677403845cc9decb55c75c5488b547278f3cd5554d1a`
**Service route:** `"PriceConsumer"` (from `price_consumer()` accessor)

**TC-PC-01: GetOracleAddress — returns None before set**
- Action: `PriceConsumer.GetOracleAddress()`
- Expected: `None` (never set in a fresh deploy)
- Note: On mainnet, oracle was already set during livetest — may return `Some(<VaraCore ID>)`

**TC-PC-02: GetCachedPrice — initial state is ("", 0)**
- Action: `PriceConsumer.GetCachedPrice()`
- Expected: `("", 0)` (tuple: last_asset="", last_price=0)
- Note: Returns `(String, u128)` tuple, not just u128

**TC-PC-03: SetOracleAddress — owner succeeds**
- Action: Owner wallet calls `PriceConsumer.SetOracleAddress(<VaraCore_program_id>)`
- Expected: `Ok(())`
- Verify: `GetOracleAddress()` → `Some(<VaraCore_program_id>)`

**TC-PC-04: SetOracleAddress — non-owner Err**
- Action: Non-owner wallet calls `SetOracleAddress`
- Expected: `Err("only the owner can set the oracle address")`

**TC-PC-05: FetchPriceFromOracle — cross-program call succeeds**
- Precondition: Oracle address set; BTC/USD price set in VaraCore
- Action: `PriceConsumer.FetchPriceFromOracle("BTC/USD")`
- Expected: `Ok(price_u128)` where price matches VaraCore's stored BTC/USD price
- Verify: `GetCachedPrice()` → `("BTC/USD", <price>)` — both asset and price cached

**TC-PC-06: FetchPriceFromOracle — oracle address not set returns Err**
- Precondition: Deploy fresh PriceConsumer without setting oracle address (or temporarily unset)
- Action: `PriceConsumer.FetchPriceFromOracle("BTC/USD")`
- Expected: `Err("oracle address not set")`

---

## Suite AC — AgentConsumer (6 cases)

**Program:** `0xc12b0063953adb7b40ed6f01521b9b0e861d7361b6eb0739cdea573e3ca2349b`
**Service route:** `"AgentConsumer"` (from `agent_consumer()` accessor)

**TC-AC-01: GetCachedScore — initial state is 0**
- Action: `AgentConsumer.GetCachedScore()`
- Expected: `0` (u32, zero before any CheckAgentTrust call)

**TC-AC-02: GetCachedDiscoveryCount — initial state is 0**
- Action: `AgentConsumer.GetCachedDiscoveryCount()`
- Expected: `0` (u32, zero before any FindOracleAgents call)

**TC-AC-03: SetVaracoreAddress — non-owner Err**
- Action: Non-owner wallet calls `SetVaracoreAddress`
- Expected: `Err("only the owner can set the varacore address")`

**TC-AC-04: CheckAgentTrust — cross-program call to Reputation.ScoreAgent**
- Precondition: VaraCore address set; agent has reputation history in VaraCore
- Action: `AgentConsumer.CheckAgentTrust(<agent_ActorId>)`
- Expected: `Ok(score_u32)` where score matches VaraCore Reputation.ScoreAgent for that agent
- Verify: `GetCachedScore()` → same score value

**TC-AC-05: CheckAgentTrust — unknown agent returns Err**
- Precondition: VaraCore address set
- Action: `AgentConsumer.CheckAgentTrust(<never-seen ActorId>)`
- Expected: `Err("agent has no recorded interactions")` (forwarded from VaraCore)

**TC-AC-06: FindOracleAgents — cross-program call to Registry.GetAgentsByCapability("price-feed")**
- Precondition: VaraCore address set; at least one agent registered with "price-feed" capability
- Action: `AgentConsumer.FindOracleAgents()`
- Expected: `Ok(count_u32)` where count = number of agents with "price-feed" capability in registry
- Verify: `GetCachedDiscoveryCount()` → same count value

---

## Pass/Fail Criteria

| Suite | Cases | Pass Threshold |
|-------|-------|---------------|
| OC (UpdatePrice) | 12 | 12/12 |
| OQ (Oracle Queries) | 10 | 10/10 |
| OS (IsStale + TWAP) | 6 | 6/6 |
| RC (Rep Commands) | 8 | 8/8 |
| RQ (Rep Queries) | 8 | 8/8 |
| GC (Registry Commands) | 10 | 10/10 |
| GQ (Registry Queries) | 8 | 8/8 |
| PC (PriceConsumer) | 6 | 6/6 |
| AC (AgentConsumer) | 6 | 6/6 |
| **Total** | **74** | **74/74** |

**PASS** = All 74 cases pass
**FAIL** = Any case fails — investigate before proceeding to V2

---

## Notes

1. **Stale FeedStatus variant**: The `FeedStatus::Stale` enum variant exists in code but is never set by `UpdatePrice` (which only sets Fresh or Degraded). A GetPrice response will never contain `status: Stale` under current logic. Do not assert for it.
2. **TWAP not queryable**: The TWAP ring buffer is internal state. No IDL method exposes it. All TWAP verification is through code review or inference from sequential UpdatePrice call success.
3. **GetTopAgents return type**: IDL shows `vec struct { f1: actor_id, f2: ReputationData }` — unnamed positional tuple. Decode accordingly.
4. **Registry routing**: On-chain prefix is `"Registry"` not `"AgentRegistry"` — the IDL type name and the SCALE routing prefix differ.
5. **Block numbers**: Tests run on mainnet — block numbers will be large (e.g. ~13M+ range). Any block-relative time checks (active_only, days_active) use current block height, which changes each test run.
