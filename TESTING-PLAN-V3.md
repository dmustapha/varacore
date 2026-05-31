# VaraCore Testing Plan — V3: Adversarial
**Version:** 1.0
**Date:** 2026-05-31
**Scope:** Attack scenarios, boundary values, overflow conditions, manipulation resistance, SCALE encoding edge cases, gas exhaustion patterns, adversarial caller patterns, full regression
**Approach:** Adversarial mindset. Every test attempts to break, bypass, or exploit a constraint. If V1 proves alive and V2 proves correct, V3 proves it cannot be broken.
**Goal:** Zero exploitable surfaces. Every invariant holds under adversarial input. No single facet untested.

---

## Attack Surface Map

| Surface | Threat Vector | Tested In |
|---------|--------------|-----------|
| UpdatePrice | Zero price, unsupported asset, source_count=0 | V1 |
| UpdatePrice | u128::MAX price/confidence, timestamp=0 | Section 1 |
| UpdatePrice | TWAP manipulation via 8 sequential spikes | Section 2 |
| ReputationService | 51st interaction evicts wrong record | Section 3 |
| ReputationService | success_bps integer truncation at exact boundary | Section 4 |
| ReputationService | Score ceiling — stays at 1000 even with 10000 interactions | Section 4 |
| Registry auth | UpdateAgent/Heartbeat/Delist with wrong caller | Section 5 |
| Registry | 21 capabilities → Err; exactly 20 → Ok | Section 6 |
| Registry | Delist cleans capability_index | Section 6 |
| Registry | 0 capabilities → Ok (no min-cap validation) | Section 6 |
| PriceConsumer | FetchPriceFromOracle for asset not in VaraCore | Section 7 |
| AgentConsumer | FindOracleAgents prefix decode with 0 oracle agents | Section 7 |
| SCALE encoding | String length 63 vs 64 (single vs two-byte prefix) | Section 8 |
| SCALE encoding | Empty string, max-length string | Section 8 |
| Gas | reply_deposit too low (historical BUG-001 scenario) | Section 9 |
| Full lifecycle | Register→update→heartbeat→delist→re-register | Section 10 |
| Regression | All V1 critical cases re-run as smoke | Section 11 |
| Price agent loop | Aggregation, outlier rejection, source fallback | Section 12 |

---

## Section 1: Price Edge Values — Boundary Inputs (10 cases)

**Goal:** Verify UpdatePrice handles extreme numeric inputs without panic or corruption.

**TC-V3-1-01: price = u128::MAX (340_282_366_920_938_463_463_374_607_431_768_211_455)**
- Input: `UpdatePrice("BTC/USD", 340282366920938463463374607431768211455, 0, <ts>, 2)`
- Expected: `Ok(())` (no upper bound check on price)
- Verify: `GetPrice("BTC/USD")` → price = u128::MAX, status = Fresh
- Note: u128 is stored as 16-byte little-endian; decoding must handle full range

**TC-V3-1-02: confidence = u128::MAX**
- Input: `UpdatePrice("ETH/USD", 1_000_000_000, 340282366920938463463374607431768211455, <ts>, 2)`
- Expected: `Ok(())` (confidence has no upper bound)
- Verify: `GetPrice("ETH/USD")` → confidence = u128::MAX

**TC-V3-1-03: price = 1 (minimum non-zero, boundary between rejected and accepted)**
- Input: `UpdatePrice("VARA/USD", 1, 0, <ts>, 2)`
- Expected: `Ok(())` (price=1 is valid)
- Verify: `GetPrice("VARA/USD")` → price = 1

**TC-V3-1-04: price = u128::MAX, then immediately overwrite with price = 1**
- Step 1: UpdatePrice price=u128::MAX → Ok
- Step 2: UpdatePrice price=1 → Ok
- GetPrice → price=1 (correct overwrite, u128::MAX not sticky)
- TWAP ring: [u128::MAX, 1, ...]. TWAP after 2 pushes = (u128::MAX + 1) / 2 = u128::MAX/2 (overflow risk?)
  - u128::MAX + 1 overflows u128! This is a POTENTIAL OVERFLOW in the TWAP sum computation.
  - Rust `let sum: u128 = self.observations[..self.count].iter().sum();` — `.sum()` wraps on overflow in release mode (no panic, silent wrap)
  - If sum overflows: TWAP = corrupted value. Not directly observable externally, but worth noting.
  - Practical risk: Only occurs with astronomically large prices (u128::MAX is not a real price)

**TC-V3-1-05: confidence > price by many orders of magnitude**
- Input: `UpdatePrice("DOT/USD", 100, 999_999_999_999_999_999, <ts>, 2)`
- Expected: `Ok(())` — no ratio check between confidence and price
- Verify: confidence stored correctly

**TC-V3-1-06: timestamp = u64::MAX (18_446_744_073_709_551_615)**
- Input: `UpdatePrice("USDT/USD", 100_000_000, 0, 18446744073709551615, 2)`
- Expected: `Ok(())` (no timestamp validation on input)
- Verify: GetPrice → timestamp = u64::MAX
- IsStale consequence: current_block_ts/1000 (a real unix ts ~1.7B) < u64::MAX → `current_ts.saturating_sub(u64::MAX) = 0` → 0 > max_age → false → NOT stale (future timestamp appears fresh)

**TC-V3-1-07: Very long asset string — unsupported → Err (no panic)**
- Input: `UpdatePrice("A"×1000 + "/USD", 100, 0, <ts>, 2)`
- Expected: `Err("unsupported asset 'AAAA...AAAA/USD'")` — long strings in error messages work
- Verify: No crash; error message returned intact

**TC-V3-1-08: Empty asset string → unsupported Err**
- Input: `UpdatePrice("", 100, 0, <ts>, 2)`
- Expected: `Err("unsupported asset ''")` (empty string is not in supported list)

**TC-V3-1-09: Supported asset with extra whitespace → Err (case-sensitive, whitespace-sensitive)**
- Input: `UpdatePrice(" BTC/USD", 100, 0, <ts>, 2)` (leading space)
- Expected: `Err("unsupported asset ' BTC/USD'")` (not in hardcoded list)
- Input: `UpdatePrice("btc/usd", 100, 0, <ts>, 2)` (lowercase)
- Expected: `Err("unsupported asset 'btc/usd'")` (exact string match)

**TC-V3-1-10: Sequential UpdatePrice with rapid timestamp changes**
- 5 updates with same asset but timestamps: [1000, 500, 100, 999999, 0] (not monotonic)
- Expected: All `Ok(())` — no monotonicity check on timestamp input
- Verify: Each GetPrice returns the most recently submitted timestamp (last write wins)

---

## Section 2: TWAP Manipulation Resistance Analysis (8 cases)

**Goal:** Characterize how much an attacker can distort the TWAP by injecting anomalous prices. The ring has 8 slots; each slot has equal weight (1/8 = 12.5%).

**TC-V3-2-01: Single spike injection — attacker posts 1 extreme price**
- Baseline: 7 normal prices of 1000 already in ring
- Attacker injects: price=100_000 (100x spike)
- Ring after spike: [100000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]
- TWAP = (100000 + 7×1000) / 8 = 107000/8 = 13375
- Normal TWAP was 1000; after spike: 13375 (13.4x distortion)
- Conclusion: Single spike has 12.5% weight — significant but not full control

**TC-V3-2-02: Full ring takeover — attacker posts 8 consecutive extreme prices**
- Baseline: ring full of price=1000
- Attacker injects 8 consecutive prices of 1_000_000
- Ring after 8 spikes: [1000000, 1000000, 1000000, 1000000, 1000000, 1000000, 1000000, 1000000]
- TWAP = 1_000_000 (fully controlled after 8 consecutive writes)
- Conclusion: 8 consecutive UpdatePrice calls allow full TWAP control. Requires 8 sequential TXs.
- Mitigation note: Only the oracle operator wallet can call UpdatePrice (price-agent.ts signs with mnemonic). If the wallet is compromised, full TWAP control is possible.

**TC-V3-2-03: Ring recovery after spike — prices return to normal**
- After TC-V3-2-01 spike: push 7 more normal prices of 1000
- After 7 normal pushes: ring = [1000,1000,1000,1000,1000,1000,1000,100000] (spike in slot 7)
- Wait: 8th normal push → ring = [1000,1000,1000,1000,1000,1000,1000,1000]
- TWAP = 1000 (fully recovered after 8 normal price updates)

**TC-V3-2-04: Minimum TWAP manipulation (push price=1, then 7 normal)**
- 7 normal prices of 1_000_000_000, then 1 price=1 (minimum)
- TWAP = (7×1_000_000_000 + 1) / 8 = 7_000_000_001/8 = 875_000_000 (12.5% drop)

**TC-V3-2-05: Crash attempt — push price=0 is rejected**
- `UpdatePrice("BTC/USD", 0, 0, <ts>, 2)` → `Err("price must be non-zero")`
- TWAP ring is NOT updated on Err (the push inside update_price only runs after validation passes)
- Verify: GetPrice("BTC/USD") price unchanged after failed update

**TC-V3-2-06: TWAP arithmetic mean vs time-weighted**
- The TwapRing is NOT a true TWAP (time-weighted average price). It's a simple arithmetic mean of the last 8 price observations, regardless of time between observations.
- Test: Push [100, 100, 100, 100, 100, 100, 100, 1000] (7 low, 1 high)
- TWAP = (700 + 1000)/8 = 1700/8 = 212 (simple mean biased toward last observation)
- A true TWAP weighted by time-held would give 100 more weight if low price was held longer
- Document limitation: This is a design choice, not a bug

**TC-V3-2-07: TWAP with all identical prices stabilizes correctly**
- Push price=5_000_000_000 eight times
- TWAP = (8 × 5_000_000_000) / 8 = 5_000_000_000
- Confirms stable oracle behavior: no drift with consistent pricing

**TC-V3-2-08: TWAP with alternating prices — eventual mean**
- Push alternating [1, 1000, 1, 1000, 1, 1000, 1, 1000] (8 pushes)
- Ring: [1,1000,1,1000,1,1000,1,1000]
- TWAP = (4×1 + 4×1000)/8 = 4004/8 = 500 (rounds down, integer division)
- Confirm: 4004/8 = 500 with remainder 4 discarded

---

## Section 3: Reputation History FIFO Enforcement (6 cases)

**Goal:** Verify exactly which record gets evicted, and that eviction is strictly FIFO (oldest first).

**TC-V3-3-01: Record 50 brings history to capacity (no eviction)**
- Create agent with exactly 50 interactions (context="interaction-N" for each)
- `GetInteractionHistory(agent, 50)` → 50 records
- Record at index 0 has context="interaction-1" (oldest still present)

**TC-V3-3-02: Record 51 evicts interaction-1, keeps interaction-2 through interaction-51**
- 51st RecordInteraction → history.remove(0) removes interaction-1
- `GetInteractionHistory(agent, 50)` → 50 records
- Index 0 context = "interaction-2" (oldest surviving)
- Index 49 context = "interaction-51" (newest)

**TC-V3-3-03: Record 52 evicts interaction-2**
- 52nd call → removes interaction-2
- GetInteractionHistory[0].context = "interaction-3"

**TC-V3-3-04: After 100 total interactions — history contains only last 50**
- `GetInteractionHistory(agent, 50)` → 50 records
- Index 0 has context="interaction-51", index 49 has context="interaction-100"
- Interactions 1–50 are permanently gone from history

**TC-V3-3-05: Eviction removes from front (index 0), not back or random**
- Verify: `history.remove(0)` in source removes the element at position 0 (O(n) shift)
- This is a correct FIFO queue. Oldest record is at index 0; newest is at the end.
- Alternative eviction strategies (ring buffer for history, random eviction) are NOT used.

**TC-V3-3-06: Score and interaction count NOT affected by history eviction**
- Record 51 interactions for agent, then ScoreAgent
- `total_interactions = 51` (not 50 — the count is in AgentReputation, not in the history Vec)
- `successful_interactions` reflects all 51 calls
- History cap affects ONLY the InteractionRecord Vec, not the score computation data

---

## Section 4: Score Ceiling and Adversarial Score Probing (10 cases)

**Goal:** Verify the score cannot exceed 1000, floor cannot go below 100 (for any non-zero interaction), and formula boundary behaviors.

**TC-V3-4-01: Score ceiling — 1024 success interactions → score=1000 (not 1010)**
- 1024 interactions, all success:
  - c1=40, c2=floor_log2(1024)×5=10×5=50, c3=0, c4=10
  - raw = min(40+50+0+10, 100) = min(100, 100) = 100
  - score = 100×10 = 1000 (ceiling enforced by .min(100))

**TC-V3-4-02: Score ceiling — 10000 success interactions → still 1000**
- c2=floor_log2(10000)×5=13×5=65
- raw = min(40+65+0+10, 100) = min(115, 100) = 100 → score=1000

**TC-V3-4-03: Score ceiling — c3 pushes over 100 even without c1/c2** ⚠️ CODE REVIEW ONLY — ~413 years of blocks, not runnable
- After 28800×512=~14.7M blocks (~413 years): days=512, c3=floor_log2(513)×7=9×7=63
- 1 success: c1=40+c2=0+c3=63+c4=10 = 113 → min(113,100)=100 → score=1000
- Score ceiling enforced regardless of which components overflow
- Verify by reading compute_score() in reputation.rs: `(c1 + c2 + c3 + c4).min(100)`

**TC-V3-4-04: Score floor — 1 failure → score=100 (not 0)**
- 1 failure: c1=0, c2=0, c3=0, c4=10 → raw=10 → score=100
- Score is never 0 for an agent with any interaction (c4=10 guarantees minimum raw=10)

**TC-V3-4-05: Score floor — 1000 failures → score=550**
- 1000 all-failure interactions:
  - c1=0 (0% success), c2=floor_log2(1000)×5=9×5=45, c3=0, c4=10
  - raw=55 → score=550 (interaction volume still counts!)
- An agent with many failures has HIGHER score than one with few failures
- This is correct by design: interaction volume (c2) rewards activity regardless of outcome

**TC-V3-4-06: success_rate_bps truncation — exactly 1 basis point below 100%**
- 9999/10000 success: success_bps=(9999×10000)/10000=9999
- c1=(9999×40)/10000=399960/10000=39 (truncated from 39.996)
- vs 100% success: c1=40
- One failure out of 10000 drops c1 by 1 (from 40 to 39)

**TC-V3-4-07: success_rate_bps truncation — 5001/10001 interactions**
- success_bps=(5001×10000)/10001=50010000/10001
  - 10001×5000=50005000; 50010000-50005000=5000; 5000<10001 → quotient=5000
  - success_bps=5000 (same as exactly 50%)
- c1=20 — same result as 5000/10000

**TC-V3-4-08: ScoreAgent for agent that only has failures — score=250**
- 10 failures, 0 successes: success_bps=0; c1=0; c2=floor_log2(10)×5=3×5=15; c3=0; c4=10
- raw=25; score=250 (not 100 — interaction count boosts even all-fail agents via c2)

**TC-V3-4-09: GetTopAgents tie-breaking**
- Two agents with identical score (both have 1 success, score=500)
- `GetTopAgents(10)` → both appear, but order is determined by BTreeMap key order (ActorId sort order)
- BTreeMap iterates in lexicographic key order; tie-breaking is NOT by score order — it's arbitrary from score POV but deterministic (depends on ActorId bytes)

**TC-V3-4-10: ScoreAgent for agent with 0 interactions → Err (not score=0)**
- Critical: There is no "zero score" state. An agent with no interactions doesn't exist in the map.
- `ScoreAgent(<fresh ActorId>)` → `Err("agent has no recorded interactions")`
- Callers must handle this Err — they cannot assume Ok(0)

---

## Section 5: Registry Authorization Enforcement (8 cases)

**Goal:** Verify that caller-identity checks for UpdateAgent, HeartbeatAgent, and DelistAgent cannot be bypassed.

**TC-V3-5-01: UpdateAgent — caller must equal agent_id parameter**
- Register agent A from wallet-A
- Wallet-B calls `UpdateAgent(agent_A_id, ...)` → `Err("only the agent itself can update its listing")`
- Verify: wallet-B cannot update agent-A's listing even with valid agent-A's ActorId

**TC-V3-5-02: UpdateAgent — caller using own ActorId succeeds**
- Wallet-A calls `UpdateAgent(wallet_A_id, ...)` → `Ok(())`
- `msg::source()` == `agent_id` parameter → check passes

**TC-V3-5-03: HeartbeatAgent — wrong caller Err**
- Wallet-B calls `HeartbeatAgent(wallet_A_id)` → `Err("only the agent itself can send a heartbeat")`

**TC-V3-5-04: HeartbeatAgent — correct caller Ok**
- Wallet-A calls `HeartbeatAgent(wallet_A_id)` → `Ok(())`

**TC-V3-5-05: DelistAgent — wrong caller Err**
- Wallet-B calls `DelistAgent(wallet_A_id)` → `Err("only the agent itself can delist")`
- Agent-A is NOT delisted; `GetAgent(wallet_A_id)` still returns Ok

**TC-V3-5-06: DelistAgent — correct caller removes agent**
- Wallet-A calls `DelistAgent(wallet_A_id)` → `Ok(())`
- `GetAgent(wallet_A_id)` → `Err("agent ... not found")`

**TC-V3-5-07: UpdateAgent for non-registered agent — Err (not auth error)**
- Wallet-A calls `UpdateAgent(wallet_A_id, ...)` but wallet-A is NOT registered
- Expected: `Err("agent not registered")` (auth check passes since caller=agent_id, but lookup fails)
- Auth check is caller==agent_id; after that, the agent lookup can fail independently

**TC-V3-5-08: HeartbeatAgent for non-registered agent — Err**
- Wallet-A calls `HeartbeatAgent(wallet_A_id)` when not registered
- Expected: `Err("agent not registered")` (same pattern as TC-V3-5-07)

---

## Section 6: Registry Capability Limits and Index Integrity (8 cases)

**Goal:** Verify the 20-capability cap and index cleanup invariants.

**TC-V3-6-01: Register with 0 capabilities — succeeds (no minimum)**
- Input: capabilities=[] (empty)
- Expected: `Ok(())` (no minimum capability check)
- Verify: `GetAgent` → capabilities=[] ; `GetAgentsByCapability("anything")` → agent not in results

**TC-V3-6-02: Register with exactly 20 capabilities — succeeds (at limit)**
- Input: capabilities=["cap1","cap2",...,"cap20"] (20 items)
- Expected: `Ok(())` (20 is allowed; check is `> 20`)

**TC-V3-6-03: Register with exactly 21 capabilities — Err**
- Input: capabilities=["cap1",...,"cap21"] (21 items)
- Expected: `Err("max 20 capabilities allowed")`

**TC-V3-6-04: UpdateAgent with 21 capabilities — Err (same limit applies)**
- Register with 3 capabilities. UpdateAgent with 21 capabilities.
- Expected: `Err("max 20 capabilities allowed")`
- Verify: Original capabilities unchanged (update aborted before modifying state)

**TC-V3-6-05: Delist removes all entries from capability_index**
- Register agent with ["price-feed", "reputation", "registry"]
- `GetAgentsByCapability("price-feed")` → [agent]
- `DelistAgent(agent)` → Ok
- `GetAgentsByCapability("price-feed")` → [] (deindexed)
- `GetAgentsByCapability("reputation")` → [] (deindexed)
- `GetAgentsByCapability("registry")` → [] (deindexed)
- All 3 indices cleaned up on delist

**TC-V3-6-06: Capability index is additive — multiple agents per capability**
- Register Agent-A with ["price-feed"], then Agent-B with ["price-feed"]
- `GetAgentsByCapability("price-feed")` → [Agent-A, Agent-B] (2 results)
- Delist Agent-A → `GetAgentsByCapability("price-feed")` → [Agent-B] (1 result)
- Delist Agent-B → `GetAgentsByCapability("price-feed")` → [] (0 results)

**TC-V3-6-07: Re-registration does NOT duplicate capability index**
- Register Agent-A with ["price-feed"] → capability_index["price-feed"] = [A]
- Re-register Agent-A with ["price-feed"] again
- Expected: capability_index["price-feed"] = [A] (not [A, A])
  - Source confirms: old caps deindexed first via `deindex_agent_capabilities`, then new caps indexed
  - deindex retains ids that != agent_id → removes A from index
  - then index adds A back → [A] (single entry)

**TC-V3-6-08: Duplicate capability strings in registration input**
- Register with capabilities=["price-feed","price-feed"] (same string twice)
- Expected: `Ok(())` — no deduplication check (capabilities is just a Vec<String>)
- Verify: `GetAgent` → capabilities=["price-feed","price-feed"] (stored as-is)
- `GetAgentsByCapability("price-feed")` → agent appears once (ActorId deduplicated at fetch? NO — agent_id added twice to index Vec)
- Actual result: capability_index["price-feed"] = [agent, agent] → agent appears TWICE in results
- This is a known limitation — document it, not a security issue

---

## Section 7: Cross-Program Failure Modes (8 cases)

**Goal:** Verify error propagation when cross-program calls fail or encounter missing state.

**TC-V3-7-01: FetchPriceFromOracle — asset not set in VaraCore**
- VaraCore: no price set for "ETH/USD"
- PriceConsumer.FetchPriceFromOracle("ETH/USD")
- Expected: `Err("asset 'ETH/USD' not registered or not yet updated")` (forwarded from VaraCore's Err reply)
- Note: PriceConsumer code path: `Ok(Err(e)) => Err(e)` — correctly propagates VaraCore's Err

**TC-V3-7-02: FetchPriceFromOracle — oracle_program_id not set**
- Fresh PriceConsumer (oracle address not set)
- Expected: `Err("oracle address not set")` (local check, no cross-program call made)

**TC-V3-7-03: FetchPriceFromOracle — oracle address set to zero address**
- SetOracleAddress to 0x0000...0000 (non-existent program)
- FetchPriceFromOracle → `Err(...)` — msg::send_bytes_for_reply to non-existent program fails
- Expected: `Err("send failed: ...")` or `Err("reply failed: ...")`

**TC-V3-7-04: CheckAgentTrust — agent not found in VaraCore**
- AgentConsumer.CheckAgentTrust(<never-scored ActorId>)
- Expected: `Err("agent has no recorded interactions")` (forwarded from ScoreAgent)

**TC-V3-7-05: CheckAgentTrust — VaraCore address not set**
- Fresh AgentConsumer (varacore address not set)
- Expected: `Err("varacore address not set")`

**TC-V3-7-06: FindOracleAgents — 0 agents with "price-feed" cap**
- VaraCore has no agents registered with "price-feed"
- AgentConsumer.FindOracleAgents() → `Ok(0)`
- SCALE decode: reply body after 31-byte prefix = Compact<u32> for Vec length = 0x00 (Compact(0))
- `GetCachedDiscoveryCount()` → 0

**TC-V3-7-07: FindOracleAgents — Compact<u32> decode for large count**
- Register 100 agents with "price-feed" cap in VaraCore
- FindOracleAgents() → `Ok(100)`
- Compact<u32>(100): 100 < 64? No. 64 ≤ 100 < 16384 → two-byte mode: [(100<<2|1)&0xFF, 100>>6]
  = [(400|1)&255, 1] = [145, 1] = 0x91 0x01 in little-endian two-byte SCALE compact
- Verify count=100 decoded correctly

**TC-V3-7-08: Reply shorter than prefix — decode guard**
- If VaraCore returns a very short reply (< 16 bytes for Oracle prefix):
  - PriceConsumer code: `if reply_bytes.len() < PREFIX { return Err("reply too short") }`
  - Prevents panic on slice-out-of-bounds

---

## Section 8: SCALE Encoding Boundary Tests (8 cases)

**Goal:** Verify encoding correctness at the exact single-byte vs two-byte length prefix boundary.

**Background:** SCALE compact integer for string lengths:
- len < 64: one byte `[len << 2]`
- 64 ≤ len < 16384: two bytes `[(len<<2 | 1) & 0xFF, (len >> 6) & 0xFF]`

**String length 63 → single byte prefix [0xFC]:**
- 63 << 2 = 252 = 0xFC (fits in one byte)

**String length 64 → two byte prefix [0x01, 0x01]:**
- 64 << 2 | 1 = 257; 257 & 0xFF = 1; 64 >> 6 = 1 → [0x01, 0x01]

**TC-V3-8-01: Asset string of 63 chars — UpdatePrice uses single-byte length prefix**
- Note: Supported assets are hardcoded ("VARA/USD" max 8 chars) — this doesn't apply to UpdatePrice asset param
- But if a malformed message used a 63-char service name or method name, the prefix would be 1 byte
- Test payload encoding: `scaleEncodeString("A"×63)` → [0xFC, 'A'×63] (64 bytes total)
- Verify: The agent's `scaleEncodeString` function handles length=63 correctly

**TC-V3-8-02: String of exactly 64 chars — uses two-byte prefix**
- `scaleEncodeString("A"×64)` → [0x01, 0x01, 'A'×64] (66 bytes total)
- Verify: The agent's two-byte branch fires: `[(((64<<2)|1)&0xFF), (64>>6)&0xFF] = [1, 1]`

**TC-V3-8-03: Context string of 256 chars — SCALE encoding in RecordInteraction**
- 256 < 64? No. 64 ≤ 256 < 16384: two-byte prefix
- `(256<<2|1)&0xFF = (1024|1)&255 = 1025&255 = 1; 256>>6=4` → [0x01, 0x04]
- Verify: context="A"×256 → stored as 256 chars; prefix is 2 bytes not 1

**TC-V3-8-04: Context string of 64 chars — two-byte prefix boundary**
- `scaleEncodeString("A"×64)` — first value in two-byte range
- Contrast with 63-char string (one-byte range)

**TC-V3-8-05: Empty string — SCALE length=0**
- `scaleEncodeString("")` → [0x00] (0<<2=0, single byte)
- Used for: empty context in RecordInteraction, empty hub_handle (but hub_handle="" is rejected)

**TC-V3-8-06: Service route encoding correctness verification**
- "Oracle" = 6 chars → [0x18] + [0x4F,0x72,0x61,0x63,0x6C,0x65] = 7 bytes
- "UpdatePrice" = 11 chars → [0x2C] + 11 bytes = 12 bytes
- Full Oracle.UpdatePrice prefix = 7+12 = 19 bytes
- Verify: agent's buildUpdatePricePayload starts with these 19 bytes before asset/price/etc

**TC-V3-8-07: Prefix calculation for all cross-program calls**
- "Oracle"(7) + "GetPrice"(9) = 16 bytes ✓ (PriceConsumer PriceConsumer::PREFIX=16)
- "Reputation"(11) + "ScoreAgent"(11) = 22 bytes ✓ (AgentConsumer::PREFIX=22)
- "Registry"(9) + "GetAgentsByCapability"(22) = 31 bytes ✓ (AgentConsumer::PREFIX=31)
- "Oracle"(7) + "ScheduleRefresh"(16) = 23 bytes (self-call payload size)

**TC-V3-8-08: ActorId encoding in cross-program payload**
- AgentConsumer.CheckAgentTrust encodes: `("Reputation", "ScoreAgent", &agent_id).encode()`
- agent_id is ActorId (32-byte fixed array in Substrate) — no length prefix in SCALE
- Payload = 22-byte prefix + 32 bytes ActorId = 54 bytes total
- VaraCore decodes actor_id from bytes 22..54

---

## Section 9: Gas and Resource Edge Cases (6 cases)

**TC-V3-9-01: reply_deposit historical bug — BUG-001 scenario**
- Old PriceConsumer had reply_deposit=2_000_000_000 (2B gas) → caused handle_reply trap
- Fixed to 50_000_000_000 (50B gas)
- Verify current: PriceConsumer source shows `50_000_000_000` in both send_bytes_for_reply calls
- Test: FetchPriceFromOracle on live mainnet → must complete without ExtrinsicFailed

**TC-V3-9-02: ScheduleRefresh gas reservation**
- `exec::reserve_gas(5_000_000_000, 200)` — reserves 5B gas for 200 blocks
- If the program has insufficient gas budget, reservation fails → `Err("gas reservation failed: ...")`
- Test: Call ScheduleRefresh — should succeed on mainnet where gas vouchers are active

**TC-V3-9-03: FetchPriceFromOracle gas — 100B gas sent to VaraCore**
- gasLimit in livetest: 100_000_000_000 (100B)
- reply_deposit: 50_000_000_000 (50B reserved for reply handling)
- Net gas for send: 100B - 50B = 50B available for execution
- Verify: GetPrice in VaraCore executes within 50B gas budget (simple BTreeMap lookup)

**TC-V3-9-04: CheckAgentTrust gas budget**
- Same pattern: 100B sent, 50B reply_deposit, 50B for ScoreAgent execution
- ScoreAgent: BTreeMap.get + compute_score (a few arithmetic ops) — well within 50B

**TC-V3-9-05: FindOracleAgents gas — large result set**
- GetAgentsByCapability returns a Vec<AgentListing> — each AgentListing is large (multiple string fields)
- With 100 agents: reply encoding could be substantial
- If reply body exceeds available memory or gas → reply truncation/Err
- Test: Find oracle agents with 100+ registered → still returns Ok(count) correctly

**TC-V3-9-06: ScheduleRefresh self-call — delayed message block count**
- `send_delayed_from_reservation(..., 100)` — message sent after 100 blocks (~200 seconds)
- At block height 100 after ScheduleRefresh, VaraCore should receive the self-message
- Verify on subscan: transaction from 0xe1f8... to 0xe1f8... (self-call) within 100 blocks

---

## Section 10: Full Agent Lifecycle Regression (10 cases)

**Goal:** Walk through a complete agent lifecycle — register, update, heartbeat, delist, re-register. Every operation must be exactly correct.

**TC-V3-10-01: Fresh register**
- Register: hub_handle="lifecycle-agent", caps=["alpha","beta"], service_type=Oracle, desc="v1"
- `GetAgent` → all fields correct; `registered_at_block = last_heartbeat_block = current_block`; `is_active=true`
- `GetAgentsByCapability("alpha")` → [lifecycle-agent]
- `GetAgentsByCapability("beta")` → [lifecycle-agent]

**TC-V3-10-02: Update hub_handle only**
- UpdateAgent: hub_handle=Some("lifecycle-agent-v2"), others=None
- `GetAgent` → hub_handle="lifecycle-agent-v2", caps=["alpha","beta"] (unchanged)
- `GetAgentsByCapability("alpha")` → still [lifecycle-agent] (caps index unchanged)

**TC-V3-10-03: Update capabilities (alpha,beta → beta,gamma)**
- UpdateAgent: caps=Some(["beta","gamma"]), others=None
- `GetAgent` → caps=["beta","gamma"]
- `GetAgentsByCapability("alpha")` → [] (deindexed)
- `GetAgentsByCapability("beta")` → [agent] (retained)
- `GetAgentsByCapability("gamma")` → [agent] (newly indexed)

**TC-V3-10-04: HeartbeatAgent refreshes last_heartbeat_block**
- Send HeartbeatAgent from wallet-A
- `GetAgent` → `last_heartbeat_block` = current block (updated)
- `is_active = true` (stored field updated by heartbeat)

**TC-V3-10-05: Record reputation for the registered agent**
- RecordInteraction(lifecycle-agent-id, true, "lifecycle test")
- ScoreAgent → score=500 (1 success)

**TC-V3-10-06: Discover agent via DiscoverAgents**
- `DiscoverAgents({service_type: Some(Oracle), capability: Some("beta"), active_only: true})` → [lifecycle-agent]
- All 3 filters applied correctly simultaneously

**TC-V3-10-07: Delist agent**
- DelistAgent(lifecycle-agent-id) → Ok(())
- `GetAgent` → `Err("agent ... not found")`
- `DiscoverAgents({})` → agent gone
- `GetAgentsByCapability("beta")` → [] (deindexed)
- `GetAgentsByCapability("gamma")` → [] (deindexed)

**TC-V3-10-08: Score survives delist (reputation persists)**
- After delist, reputation data still in ReputationService
- ScoreAgent(lifecycle-agent-id) → `Ok(ReputationData { score: 500 })`
- Reputation is independent service — delist does NOT clear reputation

**TC-V3-10-09: Re-register after delist**
- RegisterAgent again with hub_handle="lifecycle-agent-v3", caps=["delta"]
- `GetAgent` → new registration; registered_at_block=new block
- `GetAgentsByCapability("delta")` → [agent]
- `GetAgentsByCapability("beta")` → [] (old caps not restored)
- `GetAgentsByCapability("gamma")` → [] (old caps not restored)

**TC-V3-10-10: Full lifecycle on mainnet — transaction finality**
- All 9 operations above must finalize on-chain (status.isFinalized = true)
- No ExtrinsicFailed events in any operation
- Each operation produces a unique block hash

---

## Section 11: Off-Chain Price Agent Logic (8 cases)

**Goal:** Verify the off-chain price-agent.ts aggregation logic behaves correctly under various source conditions.

**TC-V3-11-01: Three-source aggregation — CoinGecko + Binance for BTC/USD**
- Prices: CoinGecko=75400, Binance=75420
- Both within 5% of median (75410): filtered=[75400, 75420]
- median(filtered)=75410; maxDeviation=max(10, 10)=10
- price=75410; confidence=10
- sourceCount=2 → FeedStatus.Fresh

**TC-V3-11-02: VARA/USD uses only CoinGecko + Gate.io (no Binance)**
- Prices: CoinGecko=0.00067, Gate.io=0.00068
- Both within 5% of median: filtered=[0.00067, 0.00068]
- finalPrice=median([0.00067, 0.00068])=(0.00067+0.00068)/2=0.000675
- On-chain: toFixedPoint(0.000675) = round(0.000675 × 1e8) = round(67500) = 67500

**TC-V3-11-03: Outlier rejection — one source 6% off median**
- CoinGecko=75000, Binance=80000 (6.7% off median 77500)
- median([75000,80000])=77500
- |75000-77500|/77500=0.032 (3.2%) → kept
- |80000-77500|/77500=0.032 (3.2%) → kept
- Wait: both within 5%; no outlier rejection here
- Test different: CoinGecko=75000, Binance=80000, Gate.io=76000
- median=76000; |75000-76000|/76000=1.3% → kept; |80000-76000|/76000=5.26% → REJECTED
- filtered=[75000, 76000]; finalPrice=median([75000,76000])=75500

**TC-V3-11-04: All sources fail — aggregatePrices returns null**
- All three sources return empty Maps (axios fails)
- `aggregatePrices("BTC/USD", [emptyMap, emptyMap])` → null
- Expected: loop skips BTC/USD with `"Could not get price for BTC/USD — skipping"` log

**TC-V3-11-05: Single source survives — sourceCount=1 → Degraded**
- Only Gate.io returns for VARA/USD (CoinGecko fails)
- values=[0.00067]; filtered=[0.00067] (outlier reject runs but nothing removed)
- finalPrice=0.00067; sourceCount=1 → UpdatePrice called with source_count=1 → Degraded

**TC-V3-11-06: toFixedPoint rounding**
- `toFixedPoint(0.00067)` = round(0.00067 × 1e8) = round(67000) = 67000
- `toFixedPoint(0.000675)` = round(0.000675 × 1e8) = round(67500) = 67500
- `toFixedPoint(75400.12345678)` = round(75400.12345678 × 1e8) = 7540012345678

**TC-V3-11-07: Price agent loop interval = 5 minutes**
- `INTERVAL_MS = 5 * 60 * 1000 = 300000 ms`
- First run: immediate on startup
- Subsequent runs: every 5 minutes via `setInterval`
- Verify: After 2 runs, on-chain timestamps differ by ~300 seconds

**TC-V3-11-08: Keystore path detection**
- `PRICE_AGENT_MNEMONIC.startsWith('/')` → keystore file path mode
  - `GearKeyring.fromJson(JSON.parse(readFileSync(path)), undefined)` — synchronous file read, undefined passphrase (empty password)
- Otherwise: `GearKeyring.fromMnemonic(PRICE_AGENT_MNEMONIC)` — async mnemonic derivation
- Test: Set PRICE_AGENT_MNEMONIC to `/Users/MAC/.vara-wallet/wallets/varacore-operator.json`
  - Should load keystore without passphrase prompt

**TC-V3-11-09: USDT/USD is structurally always Degraded — single-source asset** ⚠️ DESIGN OBSERVATION
- In price-agent.ts line 234: `'USDT/USD': [coingecko]` — only one source registered
- All other assets have 2 sources: BTC/USD=[coingecko,binance], ETH/USD=[coingecko,binance], DOT/USD=[coingecko,binance], VARA/USD=[coingecko,gateio]
- USDT/USD always produces sourceCount=1 in every UpdatePrice call
- VaraCore OracleService: source_count < 2 → FeedStatus::Degraded (not Fresh)
- Expected: GetPrice("USDT/USD").status always = Degraded (variant 2), never Fresh (variant 0)
- This is intentional — USDT is a stablecoin and Binance/Gate.io don't have a direct USDT/USD pair
- Callers querying USDT/USD must handle Degraded status as normal, not as an error
- **Implication for callers**: If AgentConsumer or third-party programs check `status == Fresh` before trusting USDT/USD price, they will always receive "degraded" — they should accept Degraded for stablecoins

---

## Section 12: Regression Baseline (8 cases)

**Goal:** After all adversarial testing, re-run critical V1 smoke tests to confirm state integrity.

**TC-V3-12-01: Oracle.GetSupportedAssets still returns exactly 5 assets**
- GetSupportedAssets() → ["VARA/USD","BTC/USD","ETH/USD","DOT/USD","USDT/USD"]
- Count=5; no duplicates; no extras; exact strings

**TC-V3-12-02: Oracle.GetPrice for all 5 assets — all Ok**
- GetPrice for each of the 5 supported assets → all return Ok(OracleData)
- None return Err (all have been updated during tests)

**TC-V3-12-03: Reputation.DecayScores → Ok (no-op)**
- DecayScores() → Ok(())
- ScoreAgent for any agent → score unchanged before vs after

**TC-V3-12-04: Registry.DiscoverAgents — no panic with empty registry**
- After delisting all agents in test session, DiscoverAgents({}) → [] (empty Vec, not crash)

**TC-V3-12-05: PriceConsumer.GetCachedPrice returns current cache state**
- After FetchPriceFromOracle("BTC/USD"): GetCachedPrice() → ("BTC/USD", <price>)
- Cache is stable until next Fetch call

**TC-V3-12-06: AgentConsumer.GetCachedScore returns current cache**
- After CheckAgentTrust(agent): GetCachedScore() → <score_u32>
- Score is stable until next Check call

**TC-V3-12-07: UpdatePrice Err paths still reject cleanly after extensive test session**
- UpdatePrice("BTC/USD", 0, 0, <ts>, 2) → Err("price must be non-zero")
- UpdatePrice("FAKE/USD", 100, 0, <ts>, 2) → Err("unsupported asset 'FAKE/USD'")
- No state pollution from earlier tests — error paths still clean

**TC-V3-12-08: All programs still alive on mainnet**
- VaraCore: `api.query.gearProgram.activePrograms("0xe1f8...")` → exists
- PriceConsumer: `api.query.gearProgram.activePrograms("0xc683...")` → exists
- AgentConsumer: `api.query.gearProgram.activePrograms("0xc12b...")` → exists
- Programs are immutable; cannot be killed or upgraded post-deploy

---

## Pass/Fail Criteria

| Section | Cases | Pass Threshold |
|---------|-------|---------------|
| 1: Price Edge Values | 10 | 10/10 |
| 2: TWAP Manipulation | 8 | 8/8 |
| 3: History FIFO | 6 | 6/6 |
| 4: Score Ceiling/Floor | 10 | 10/10 |
| 5: Registry Auth | 8 | 8/8 |
| 6: Registry Caps/Index | 8 | 8/8 |
| 7: Cross-Program Failures | 8 | 8/8 |
| 8: SCALE Encoding | 8 | 8/8 |
| 9: Gas/Resource | 6 | 6/6 |
| 10: Full Lifecycle | 10 | 10/10 |
| 11: Price Agent Logic | 8 | 8/8 |
| 12: Regression | 8 | 8/8 |
| **Total** | **98** | **98/98** |

**PASS** = All 98 cases pass
**V3 FAIL** = Investigate invariant violation before demo

---

## Findings That Need Documentation (regardless of pass/fail)

1. **TWAP overflow risk**: If two consecutive prices are both u128::MAX/2 or larger, their sum overflows u128. Panic does not occur in release (wraps silently), but TWAP value is corrupted. Theoretical only for real market prices.

2. **GetTopAgents tie-breaking is non-deterministic from score perspective**: Two agents with identical scores are ordered by ActorId byte comparison (BTreeMap ordering), not by registration time or any semantic criterion.

3. **FeedStatus::Stale is dead code**: The Stale variant exists in the FeedStatus enum but UpdatePrice never emits it. A GetPrice response will never return Stale under current logic.

4. **History cap eviction is O(n)**: `history.remove(0)` on a Vec shifts all 49 remaining elements. For the 50-record cap this is acceptable, but if the cap were raised to thousands, this would be expensive.

5. **Duplicate capabilities are stored**: Registering with capabilities=["x","x"] stores both and adds the agent twice to the capability index. Not a security issue but may inflate GetAgentsByCapability counts.

6. **GetAgent.is_active may be stale**: The stored `is_active` field is updated only by HeartbeatAgent and RegisterAgent, not recomputed on GetAgent queries. Use GetAgentsByCapability or DiscoverAgents for live active status.

7. **TWAP is NOT a true TWAP**: It's a simple arithmetic mean of the 8 most recent price observations, regardless of the time interval between them. The name "TwapRing" is aspirational — actual time-weighting is not implemented.

---

## Grand Total Across All Three Plans

| Plan | Cases |
|------|-------|
| V1: Foundation | 74 |
| V2: Precision | 111 |
| V3: Adversarial | 98 |
| **Grand Total** | **283** |
