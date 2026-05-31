# VaraCore Testing Plan — V2: Precision
**Version:** 1.0
**Date:** 2026-05-31
**Scope:** Exact state machine correctness, sequential state build-up, formula component isolation, filter combinatorics, boundary conditions, cross-program state propagation
**Approach:** Section-based. Every test case computes exact expected values from source code. No hand-waving — every assertion has a derivation.
**Goal:** Prove the math is right, not just that the methods don't crash. V1 proves alive; V2 proves correct.

---

## Pre-computed Reference Values

### Score Formula Derivation
```
compute_score(rep, block):
  c1 = (success_bps × 40) / 10_000     # max 40
  c2 = floor_log2(total_interactions) × 5  # floor_log2(n) = 63 - leading_zeros(n)
  c3 = floor_log2(days_active + 1) × 7  # days_active = (block - first_block) / 28800
  c4 = 10 if total_interactions > 0 else 0
  raw = min(c1 + c2 + c3 + c4, 100)
  score = raw × 10
```

### floor_log2 table
| n | floor_log2(n) |
|---|--------------|
| 0 | 0 |
| 1 | 0 |
| 2 | 1 |
| 3 | 1 |
| 4 | 2 |
| 5–7 | 2 |
| 8–15 | 3 |
| 16–31 | 4 |
| 32–63 | 5 |
| 64–127 | 6 |
| 128–255 | 7 |
| 256–511 | 8 |
| 512–1023 | 9 |
| 1024–2047 | 10 |

### Score table (same-block: c3=0)
| interactions | all success → success_bps | c1 | c2 | c3 | c4 | raw | score |
|-------------|--------------------------|----|----|----|----|-----|-------|
| 1 | 10000 | 40 | 0 | 0 | 10 | 50 | **500** |
| 2 | 10000 | 40 | 5 | 0 | 10 | 55 | **550** |
| 3 | 10000 | 40 | 5 | 0 | 10 | 55 | **550** |
| 4 | 10000 | 40 | 10 | 0 | 10 | 60 | **600** |
| 5–7 | 10000 | 40 | 10 | 0 | 10 | 60 | **600** |
| 8–15 | 10000 | 40 | 15 | 0 | 10 | 65 | **650** |
| 16–31 | 10000 | 40 | 20 | 0 | 10 | 70 | **700** |
| 32–63 | 10000 | 40 | 25 | 0 | 10 | 75 | **750** |
| 64–127 | 10000 | 40 | 30 | 0 | 10 | 80 | **800** |
| 128–255 | 10000 | 40 | 35 | 0 | 10 | 85 | **850** |
| 256–511 | 10000 | 40 | 40 | 0 | 10 | 90 | **900** |
| 512–1023 | 10000 | 40 | 45 | 0 | 10 | 95 | **950** |
| ≥1024 | 10000 | 40 | 50+ | 0 | 10 | 100 (capped) | **1000** |

### TWAP ring buffer state (push sequence)
| Push # | Price pushed | Ring state (obs[0..8]) | count | TWAP |
|--------|-------------|----------------------|-------|------|
| 1 | 100 | [100,_,_,_,_,_,_,_] | 1 | 100 |
| 2 | 200 | [100,200,_,_,_,_,_,_] | 2 | 150 |
| 3 | 300 | [100,200,300,_,_,_,_,_] | 3 | 200 |
| 4 | 400 | [100,200,300,400,_,_,_,_] | 4 | 250 |
| 5 | 500 | [100,200,300,400,500,_,_,_] | 5 | 300 |
| 6 | 600 | [100,200,300,400,500,600,_,_] | 6 | 350 |
| 7 | 700 | [100,200,300,400,500,600,700,_] | 7 | 400 |
| 8 | 800 | [100,200,300,400,500,600,700,800] | 8 | 450 |
| 9 | 900 | [**900**,200,300,400,500,600,700,800] | 8 | 550 |
| 10 | 1000 | [900,**1000**,300,400,500,600,700,800] | 8 | 650 |
| 11 | 1100 | [900,1000,**1100**,400,500,600,700,800] | 8 | 750 |

TWAP = sum(observations[0..count]) / count. After wrap: reads ALL 8 slots starting from index 0.
TWAP is NOT directly queryable — this table is for code-review verification only.

---

## Section 1: UpdatePrice State Machine — FeedStatus Transitions (8 cases)

**Goal:** Verify source_count drives FeedStatus exactly, and consecutive updates fully overwrite state.

**TC-V2-1-01: source_count=1 → status=Degraded (exact)**
- Input: `UpdatePrice("BTC/USD", 5_000_000_000, 100_000_000, <ts>, 1)`
- Expected: `Ok(())`
- Verify: `GetPrice("BTC/USD")` → `status: Degraded, source_count: 1`

**TC-V2-1-02: source_count=2 → status=Fresh**
- Input: `UpdatePrice("BTC/USD", 5_000_000_000, 100_000_000, <ts>, 2)`
- Expected: `GetPrice` → `status: Fresh, source_count: 2`

**TC-V2-1-03: source_count=3 → status=Fresh**
- Input: `UpdatePrice("BTC/USD", 5_000_000_000, 100_000_000, <ts>, 3)`
- Expected: `GetPrice` → `status: Fresh, source_count: 3`

**TC-V2-1-04: Degraded → Fresh upgrade on re-update**
- Step 1: `UpdatePrice("ETH/USD", 2_100_000_000_000, 0, <ts>, 1)` → GetPrice shows Degraded
- Step 2: `UpdatePrice("ETH/USD", 2_100_000_000_000, 0, <ts>, 3)` → GetPrice shows Fresh
- Verify: Status changes from Degraded to Fresh on second call

**TC-V2-1-05: Fresh → Degraded downgrade on re-update**
- Step 1: `UpdatePrice("DOT/USD", 122_000_000, 0, <ts>, 3)` → Fresh
- Step 2: `UpdatePrice("DOT/USD", 120_000_000, 0, <ts+1>, 1)` → Degraded
- Verify: Status changes from Fresh to Degraded; price also updated to 120_000_000

**TC-V2-1-06: Full field overwrite on re-update**
- Step 1: `UpdatePrice("VARA/USD", 6_700_000, 100_000, 1_000_000, 2)`
- Step 2: `UpdatePrice("VARA/USD", 9_999_999, 999_999, 2_000_000, 1)`
- Expected GetPrice after step 2:
  - `price: 9_999_999`
  - `confidence: 999_999`
  - `timestamp: 2_000_000`
  - `source_count: 1`
  - `status: Degraded`
- All 5 fields from step 1 are completely replaced, not merged

**TC-V2-1-07: FeedStatus enum SCALE values**
- Fresh is variant 0 in the enum (declaration order: Fresh, Stale, Degraded)
- Degraded is variant 2
- Stale is variant 1 (exists in enum but UpdatePrice never sets it)
- Verify: A reply with source_count=2 should decode status byte as 0x00 (Fresh)
- Verify: A reply with source_count=1 should decode status byte as 0x02 (Degraded)

**TC-V2-1-08: UpdatePrice does NOT touch other assets' state**
- Step 1: Update BTC/USD (price=A), ETH/USD (price=B)
- Step 2: Update BTC/USD (price=C)
- Verify: `GetPrice("ETH/USD")` → price still B (not affected by BTC/USD update)

---

## Section 2: TWAP Ring Buffer — Sequential State Verification (10 cases)

**Goal:** Verify the ring buffer fills, wraps, and overwrites exactly as the code specifies. Not queryable via IDL — verify through sequential UpdatePrice calls and code review alignment.

**TC-V2-2-01: Fresh ring — first UpdatePrice sets count=1**
- Precondition: Fresh asset state (use "USDT/USD" if unused)
- Action: `UpdatePrice("USDT/USD", 100_000_000_000, 0, <ts>, 2)` once
- Code review: TwapRing { observations: [100B,0,0,0,0,0,0,0], head: 1, count: 1 }
- Internal TWAP = observations[..1].sum() / 1 = 100_000_000_000

**TC-V2-2-02: Two updates — count=2, twap=arithmetic mean**
- Call UpdatePrice("USDT/USD") twice: prices [100_000_000, 200_000_000]
- Internal TWAP = (100M + 200M) / 2 = 150_000_000

**TC-V2-2-03: Four updates — count=4**
- Prices: [100, 200, 300, 400] (in base units)
- Internal TWAP = (100+200+300+400)/4 = 250

**TC-V2-2-04: Eight updates — ring exactly full (count=8)**
- Prices: [100,200,300,400,500,600,700,800]
- After 8th push: head wraps to 0; count reaches 8 and stays
- Internal TWAP = (100+200+300+400+500+600+700+800)/8 = 3600/8 = 450
- All 8 calls must return Ok(())

**TC-V2-2-05: Ninth update — slot 0 overwritten (ring wrap)**
- Prices: [100,200,300,400,500,600,700,800,900]
- After 9th push: observations[0]=900; head=1; count=8 (unchanged)
- Ring state: [900,200,300,400,500,600,700,800]
- Internal TWAP = (900+200+300+400+500+600+700+800)/8 = 4400/8 = 550
- Note: slot 0's old value 100 is permanently lost

**TC-V2-2-06: Tenth update — slot 1 overwritten**
- After 10th push (price=1000): observations[1]=1000; head=2; count=8
- Ring: [900,1000,300,400,500,600,700,800]
- TWAP = (900+1000+300+400+500+600+700+800)/8 = 5200/8 = 650

**TC-V2-2-07: TWAP with identical prices (all same value)**
- Push price=500 eight times
- Ring: [500,500,500,500,500,500,500,500]
- TWAP = 4000/8 = 500 (equals the constant price — stable oracle)

**TC-V2-2-08: TWAP with alternating extremes**
- Push alternating [0+1,1000,1,1000,1,1000,1,1000] (use 1 not 0 since 0 is rejected)
- Ring after 8: [1,1000,1,1000,1,1000,1,1000]
- TWAP = (1+1000+1+1000+1+1000+1+1000)/8 = 4004/8 = 500 (rounds down)

**TC-V2-2-09: TWAP ring — 100 rapid UpdatePrice calls all succeed**
- Action: Loop UpdatePrice("BTC/USD") 100 times with incrementing prices
- Expected: All 100 calls return Ok(()) — ring never errors on overflow, count stays clamped at 8

**TC-V2-2-10: Ring per asset is independent**
- Update BTC/USD 5 times (ring count=5)
- Update ETH/USD 3 times (ring count=3)
- BTC ring: count=5, TWAP=mean of 5 values
- ETH ring: count=3, TWAP=mean of 3 values
- Neither ring affects the other

---

## Section 3: IsStale Boundary Conditions (6 cases)

**Goal:** Verify the exact boundary: `current_ts - data.timestamp > max_age` (strict GT, not GTE).

**TC-V2-3-01: Unknown asset → always true regardless of max_age**
- Action: `IsStale("NEVERUPDATED/USD", 999_999_999)`
- Expected: `true` (no entry in prices map → stale)

**TC-V2-3-02: Asset with timestamp=0, max_age=60 → stale**
- Action: UpdatePrice("USDT/USD", 100M, 0, 0, 2), then `IsStale("USDT/USD", 60)`
- Expected: `true` (current block ts in seconds is ~1.7 billion, far > 60)

**TC-V2-3-03: Asset with current timestamp, max_age=86400 → not stale**
- Action: UpdatePrice("VARA/USD", 6M, 0, <Date.now()/1000 as u64>, 2)
- Then: `IsStale("VARA/USD", 86400)` (24 hours)
- Expected: `false` (just updated, well within window)

**TC-V2-3-04: Boundary value — max_age equals exact age**
- Setup: UpdatePrice with timestamp=T. Current block_timestamp/1000 = T + 300.
- `IsStale(asset, 300)` → `(T+300) - T > 300` → `300 > 300` → `false` (NOT stale at exact boundary)
- Verify: IsStale with max_age=301 on same data → `300 > 301` → `false` (still not stale)
- Verify: IsStale with max_age=299 on same data → `300 > 299` → `true` (stale)

**TC-V2-3-05: max_age=0 — stale unless timestamp equals block_ts exactly**
- Expected: `true` in almost all cases (any non-zero age → stale)
- Note: block_timestamp/1000 rounds down from ms. Tiny rounding could make age=0 for same block.

**TC-V2-3-06: Very large max_age (u64::MAX) — never stale for any real timestamp**
- Action: `IsStale("BTC/USD", 18_446_744_073_709_551_615)`
- Expected: `false` (no realistic timestamp can create an age exceeding u64::MAX)

---

## Section 4: Reputation Score Formula — Component Isolation (12 cases)

**Goal:** Isolate each of c1, c2, c3, c4 to verify independent correctness.

### c4 isolation — base score for any interaction

**TC-V2-4-01: Zero interactions → no c4 (agent not found)**
- `ScoreAgent(<fresh_agent>)` → `Err("agent has no recorded interactions")`
- c4 only applies when total_interactions > 0

**TC-V2-4-02: One interaction regardless of success → c4=10**
- RecordInteraction(agent, false, "") — 1 failure
- ScoreAgent → c4=10 applies: c1=0+c2=0+c3=0+c4=10 = raw=10 → score=100
- RecordInteraction(agent2, true, "") — 1 success
- ScoreAgent(agent2) → c1=40+c2=0+c3=0+c4=10 = raw=50 → score=500
- c4 is the minimum "participation bonus"

### c1 isolation — success rate contribution

**TC-V2-4-03: 100% success, 1 interaction → c1=40**
- 1 success: success_bps=10000; c1=(10000×40)/10000=40
- With c2=0, c3=0, c4=10: raw=50, score=500

**TC-V2-4-04: 50% success, 2 interactions → c1=20**
- 1 success + 1 failure: success_bps=(1×10000)/2=5000; c1=(5000×40)/10000=20
- With c2=floor_log2(2)×5=5, c3=0, c4=10: raw=35, score=350

**TC-V2-4-05: 0% success, 2 interactions → c1=0**
- 2 failures: success_bps=0; c1=0
- With c2=5, c3=0, c4=10: raw=15, score=150

**TC-V2-4-06: 33% success, 3 interactions → c1=13**
- 1 success + 2 failures: success_bps=(1×10000)/3=3333; c1=(3333×40)/10000=13 (integer division: 133320/10000=13)
- With c2=floor_log2(3)×5=5, c3=0, c4=10: raw=28, score=280

### c2 isolation — interaction volume contribution

**TC-V2-4-07: c2 at each log2 boundary (all success, same block)**
- 1 interaction: c2=floor_log2(1)×5=0×5=0; score=500
- 2 interactions: c2=floor_log2(2)×5=1×5=5; score=550
- 4 interactions: c2=floor_log2(4)×5=2×5=10; score=600
- 8 interactions: c2=floor_log2(8)×5=3×5=15; score=650
- 16 interactions: c2=floor_log2(16)×5=4×5=20; score=700
- 32 interactions: c2=floor_log2(32)×5=5×5=25; score=750
- 64 interactions: c2=floor_log2(64)×5=6×5=30; score=800
- Note: To accumulate N interactions, call RecordInteraction N times for same agent

**TC-V2-4-08: c2 boundary — 3 vs 4 interactions (same score)**
- 3 interactions (all success): floor_log2(3)=1, c2=5; score=550
- 4 interactions (all success): floor_log2(4)=2, c2=10; score=600
- Confirm: 3→4 is a log2 boundary; score jumps from 550 to 600

### c3 isolation — longevity contribution

**TC-V2-4-09: c3=0 when days_active=0 (same-block test)**
- All same-block tests: first_active_block=current_block; days=(current - current)/28800=0
- c3=floor_log2(0+1)×7=floor_log2(1)×7=0×7=0
- Same-block score for 1 success: 500 (no longevity bonus)

**TC-V2-4-10: c3 after 1 day (28800 blocks)**
- days_active=1: c3=floor_log2(1+1)×7=floor_log2(2)×7=1×7=7
- For 1 success after 1 day: c1=40,c2=0,c3=7,c4=10; raw=57; score=570
- Note: Cannot test this in a single session — requires block gap ≥28800

**TC-V2-4-11: c3 after 3 days (86400 blocks)** ⚠️ CODE REVIEW ONLY — not runnable in a single session
- days_active=3: c3=floor_log2(3+1)×7=floor_log2(4)×7=2×7=14
- For 1 success: c1=40,c2=0,c3=14,c4=10; raw=64; score=640
- Verify by reading days_active() in reputation.rs: `(current_block - first_active_block) / 28_800`

**TC-V2-4-12: c3 after 7 days (201600 blocks)** ⚠️ CODE REVIEW ONLY — not runnable in a single session
- days_active=7: c3=floor_log2(7+1)×7=floor_log2(8)×7=3×7=21
- For 1 success: c1=40,c2=0,c3=21,c4=10; raw=71; score=710
- Verify by reading days_active() in reputation.rs: `(current_block - first_active_block) / 28_800`

---

## Section 5: Score at Interaction Count Boundaries (12 cases)

**Goal:** Verify score jumps exactly at log2 boundaries. Use same-block recording (c3=0), all success.

**Setup:** For each test, use a FRESH agent (new ActorId per test to avoid state bleed).

**TC-V2-5-01:** 1 interaction (all success) → score=**500**
- c1=40, c2=0, c3=0, c4=10 → raw=50

**TC-V2-5-02:** 2 interactions (all success) → score=**550**
- c1=40, c2=5, c3=0, c4=10 → raw=55

**TC-V2-5-03:** 3 interactions (all success) → score=**550** (same as 2)
- floor_log2(3)=1 → c2=5 (no change from 2)

**TC-V2-5-04:** 4 interactions (all success) → score=**600**
- floor_log2(4)=2 → c2=10 → raw=60

**TC-V2-5-05:** 7 interactions (all success) → score=**600** (same as 4)
- floor_log2(7)=2 → c2=10

**TC-V2-5-06:** 8 interactions (all success) → score=**650**
- floor_log2(8)=3 → c2=15 → raw=65

**TC-V2-5-07:** 15 interactions → score=**650** (same as 8)
- floor_log2(15)=3

**TC-V2-5-08:** 16 interactions → score=**700**
- floor_log2(16)=4 → c2=20 → raw=70

**TC-V2-5-09:** 32 interactions → score=**750**
- floor_log2(32)=5 → c2=25 → raw=75

**TC-V2-5-10:** 64 interactions → score=**800**
- floor_log2(64)=6 → c2=30 → raw=80

**TC-V2-5-11:** 128 interactions → score=**850**
- floor_log2(128)=7 → c2=35 → raw=85

**TC-V2-5-12:** 256 interactions → score=**900**
- floor_log2(256)=8 → c2=40 → raw=90

---

## Section 6: Mixed Success Rate Scoring (6 cases)

**TC-V2-6-01: 1 success / 1 failure (50%) with 2 total → score=350**
- success_bps=(1×10000)/2=5000; c1=20; c2=floor_log2(2)×5=5; c3=0; c4=10; raw=35; score=350

**TC-V2-6-02: 1 success / 2 failures (33%) with 3 total → score=280**
- success_bps=(1×10000)/3=3333; c1=13; c2=floor_log2(3)×5=5; c3=0; c4=10; raw=28; score=280

**TC-V2-6-03: 5 success / 5 failures (50%) with 10 total → score=450**
- success_bps=(5×10000)/10=5000; c1=(5000×40)/10000=20; c2=floor_log2(10)×5=3×5=15; c3=0; c4=10; raw=45; score=450

**TC-V2-6-04: 1 success / 9 failures (10%) with 10 total → score=290**
- success_bps=(1×10000)/10=1000; c1=(1000×40)/10000=4; c2=floor_log2(10)×5=15; c3=0; c4=10; raw=29; score=290

**TC-V2-6-05: 0 success / 10 failures (0%) with 10 total → score=250**
- success_bps=0; c1=0; c2=floor_log2(10)×5=15; c3=0; c4=10; raw=25; score=250
- Note: 0% success rate doesn't remove c4; c4 fires when total_interactions > 0

**TC-V2-6-06: success_rate_bps integer truncation at 1/3**
- success_bps for 1/3: (1×10000)/3 = 3333 (truncated, not 3333.33)
- c1 = (3333×40)/10000 = 133320/10000 = 13 (truncated)
- Compare to 33.33%: exact c1 would be 13.33 → truncates to 13

---

## Section 7: Reputation History Cap — 50-Record Boundary (6 cases)

**Goal:** Verify the FIFO eviction at capacity 50: oldest record drops, newest kept.

**TC-V2-7-01: 49 interactions → 49 records in history**
- RecordInteraction 49 times for same agent
- `GetInteractionHistory(agent, 50)` → returns exactly 49 records

**TC-V2-7-02: 50 interactions → 50 records (at capacity)**
- RecordInteraction 50 times
- `GetInteractionHistory(agent, 50)` → returns exactly 50 records
- `len == 50`; no eviction yet

**TC-V2-7-03: 51 interactions → still 50 records (oldest evicted)**
- RecordInteraction 51 times (call 51 has context="interaction-51")
- `GetInteractionHistory(agent, 50)` → 50 records
- First record has context of interaction #2 (interaction #1 was evicted at history.remove(0))
- Last record has context of "interaction-51"

**TC-V2-7-04: 100 interactions → still 50 records**
- After 100 calls, history contains only the last 50 (interactions #51–#100)
- `GetInteractionHistory(agent, 50)` → 50 records
- Earliest record's block_number corresponds to interaction #51

**TC-V2-7-05: GetInteractionHistory limit cap at 50**
- `GetInteractionHistory(agent, 100)` with 50 records stored → cap=min(100,50)=50 → returns 50 records
- `GetInteractionHistory(agent, 51)` → same: returns 50 records

**TC-V2-7-06: GetInteractionHistory limit=0 returns empty**
- `GetInteractionHistory(agent, 0)` → cap=min(0,50)=0 → start=len.saturating_sub(0)=len → history[len..]=empty
- Expected: `[]`

---

## Section 8: GetInteractionHistory Window Correctness (5 cases)

**Goal:** Verify that `history[start..]` correctly slices from the tail.

**TC-V2-8-01: limit=1 returns only the most recent record**
- Precondition: 10 interactions recorded with distinct contexts "ctx-1" through "ctx-10"
- `GetInteractionHistory(agent, 1)` → [record with context="ctx-10"]
- start = 10 - min(1,50) = 10-1 = 9; history[9..] = [record_10]

**TC-V2-8-02: limit=3 returns last 3 records in order**
- `GetInteractionHistory(agent, 3)` → [ctx-8, ctx-9, ctx-10]
- start=7; history[7..] = records 8,9,10 (oldest to newest)

**TC-V2-8-03: limit > actual records returns all records**
- 5 records, limit=10 → cap=min(10,50)=10 → start=5-10=saturating_sub→0 → history[0..]=all 5 records

**TC-V2-8-04: InteractionRecord fields are correct**
- RecordInteraction(agent, true, "my-context") → InteractionRecord should contain:
  - `caller: <msg::source() ActorId>` (the wallet that called RecordInteraction, not agent_id)
  - `success: true`
  - `block_number: <block at call time>`
  - `context: "my-context"`

**TC-V2-8-05: History records are ordered oldest-first**
- 3 interactions at blocks B1 < B2 < B3
- `GetInteractionHistory(agent, 3)` → records in order [B1, B2, B3] (oldest to newest)
- No reverse sorting — Vec preserves push order

---

## Section 9: GetTopAgents — Ordering and Cap (6 cases)

**TC-V2-9-01: GetTopAgents sorted by score descending**
- Setup: Agent A (score=600), Agent B (score=800), Agent C (score=500)
- `GetTopAgents(10)` → [B(800), A(600), C(500)]
- Sorted by `b.score.cmp(&a.score)` (descending)

**TC-V2-9-02: limit=0 returns empty**
- `GetTopAgents(0)` → cap=min(0,100)=0 → `scored.truncate(0)` → `[]`

**TC-V2-9-03: limit=100 returns up to 100 agents**
- With 50 agents scored: `GetTopAgents(100)` → 50 results (capped by actual count)

**TC-V2-9-04: limit=200 capped at 100**
- `GetTopAgents(200)` → cap=min(200,100)=100 → at most 100 results

**TC-V2-9-05: GetTopAgents return type structure**
- Return type is `Vec<(ActorId, ReputationData)>` in Rust, encoded as unnamed struct in IDL:
  `vec struct { f1: actor_id, f2: ReputationData }`
- Verify: each entry has `f1` (32-byte ActorId) and `f2` (ReputationData with 5 fields)

**TC-V2-9-06: Score reflects current block (not cached)**
- Agent recorded 1 interaction at block B
- `GetTopAgents(10)` at block B: score=500 (days_active=0)
- `GetTopAgents(10)` at block B+28800: score may include c3 bonus (if first_active_block=B)
- Note: ScoreAgent/GetTopAgents always compute fresh from stored data, not from a cached score field

---

## Section 10: Registry DiscoveryFilter — All 8 Combinations (16 cases)

**Setup:** Register 3 agents before these tests:
- **Agent-O**: service_type=Oracle, capabilities=["price-feed","twap"], active (just registered)
- **Agent-D**: service_type=DeFi, capabilities=["lending","liquidity"], active
- **Agent-S**: service_type=Social, capabilities=["price-feed"], active

**Combo 1: No filters → all agents**
**TC-V2-10-01:** `DiscoverAgents({ service_type: None, capability: None, active_only: false })` → 3 results

**Combo 2: service_type filter only**
**TC-V2-10-02:** `{ service_type: Some(Oracle), capability: None, active_only: false }` → [Agent-O] (1 result)
**TC-V2-10-03:** `{ service_type: Some(DeFi), capability: None, active_only: false }` → [Agent-D] (1 result)
**TC-V2-10-04:** `{ service_type: Some(Agent), capability: None, active_only: false }` → [] (0 results, no Agent-type agents)

**Combo 3: capability filter only**
**TC-V2-10-05:** `{ service_type: None, capability: Some("price-feed"), active_only: false }` → [Agent-O, Agent-S] (2 results — both have "price-feed")
**TC-V2-10-06:** `{ service_type: None, capability: Some("lending"), active_only: false }` → [Agent-D] (1 result)
**TC-V2-10-07:** `{ service_type: None, capability: Some("nonexistent"), active_only: false }` → [] (0 results)

**Combo 4: service_type AND capability**
**TC-V2-10-08:** `{ service_type: Some(Oracle), capability: Some("price-feed"), active_only: false }` → [Agent-O] (1 result — Agent-S has "price-feed" but is Social type)
**TC-V2-10-09:** `{ service_type: Some(DeFi), capability: Some("price-feed"), active_only: false }` → [] (DeFi agent doesn't have "price-feed")

**Combo 5: active_only only**
**TC-V2-10-10:** `{ service_type: None, capability: None, active_only: true }` → 3 results (all just registered, heartbeat=current block)
**TC-V2-10-11:** `{ service_type: None, capability: None, active_only: true }` after 1000+ blocks for Agent-D → 2 results (Agent-D excluded as stale)

**Combo 6: service_type + active_only**
**TC-V2-10-12:** `{ service_type: Some(Oracle), capability: None, active_only: true }` → [Agent-O] (active Oracle)
**TC-V2-10-13:** `{ service_type: Some(DeFi), capability: None, active_only: true }` → [Agent-D] if active

**Combo 7: capability + active_only**
**TC-V2-10-14:** `{ service_type: None, capability: Some("price-feed"), active_only: true }` → [Agent-O, Agent-S] if both active

**Combo 8: All three filters**
**TC-V2-10-15:** `{ service_type: Some(Oracle), capability: Some("price-feed"), active_only: true }` → [Agent-O]
**TC-V2-10-16:** `{ service_type: Some(Oracle), capability: Some("twap"), active_only: true }` → [Agent-O]

---

## Section 11: Registry Active_Only Staleness — Heartbeat Block Boundary (6 cases)

**Goal:** Verify `is_active = current_block - last_heartbeat_block < 1000` (strict less-than).

**TC-V2-11-01: Just registered → is_active=true**
- Register agent at block B. `GetAgent` → `last_heartbeat_block=B, is_active=true`
- `DiscoverAgents(active_only=true)` → agent appears

**TC-V2-11-02: Heartbeat refreshes staleness**
- Register at B. Wait Δ blocks. Send HeartbeatAgent.
- `GetAgent` → `last_heartbeat_block=B+Δ, is_active=true`

**TC-V2-11-03: active_only boundary at exactly 999 blocks gap**
- If last_heartbeat=B, current=B+999: 999 < 1000 → `is_active=true`
- `DiscoverAgents(active_only=true)` → included

**TC-V2-11-04: active_only boundary at exactly 1000 blocks gap**
- If last_heartbeat=B, current=B+1000: 1000 < 1000 → `false` → `is_active=false`
- `DiscoverAgents(active_only=true)` → excluded
- Note: 1000 blocks = ~2000 seconds (~33 minutes) on Vara mainnet at ~2s/block

**TC-V2-11-05: GetAgentsByCapability does NOT apply active_only filter**
- Register Oracle agent with "price-feed". Let 1000+ blocks pass.
- `GetAgentsByCapability("price-feed")` → agent still appears (no active_only gate here)
- `is_active` field in returned listing is UPDATED to reflect current staleness
- `DiscoverAgents(active_only=true)` → agent excluded

**TC-V2-11-06: is_active field in AgentListing updated at query time**
- `GetAgent` always recomputes is_active? Actually NO — `GetAgent` reads `listing.is_active` field directly from stored state
- `GetAgentsByCapability` DOES recompute `listing.is_active = RegistryState::is_active(&listing, current_block)` (from source: line `listing.is_active = RegistryState::is_active(...)`)
- `DiscoverAgents` filters on `RegistryState::is_active(listing, current_block)` but does NOT update the stored field
- Implication: `GetAgent` may show stale `is_active=true` even after 1000 blocks (stored from register/heartbeat time). `GetAgentsByCapability` shows correct is_active.

---

## Section 12: Registry Re-Registration and Capability Index Cleanup (5 cases)

**Goal:** Verify that re-registering an agent cleans up old capability indices.

**TC-V2-12-01: Register agent with cap "alpha"**
- `GetAgentsByCapability("alpha")` → [agent]
- `GetAgentsByCapability("beta")` → [] (not in "beta")

**TC-V2-12-02: Re-register same agent with cap "beta" (no "alpha")**
- Call RegisterAgent again from same wallet with capabilities=["beta"]
- Expected: `Ok(())` (re-registration succeeds)
- Verify: `GetAgentsByCapability("beta")` → [agent]
- Verify: `GetAgentsByCapability("alpha")` → [] (old cap removed from index)

**TC-V2-12-03: Re-registration updates all fields**
- Original: hub_handle="old-handle", service_type=Oracle
- Re-register: hub_handle="new-handle", service_type=DeFi
- `GetAgent` → hub_handle="new-handle", service_type=DeFi, registered_at_block=new_block

**TC-V2-12-04: Re-registration resets heartbeat to current block**
- Register at B1. Wait. Re-register at B2.
- `GetAgent` → `last_heartbeat_block=B2` (not B1)

**TC-V2-12-05: UpdateAgent capability change also cleans index**
- Register with ["alpha"]. Then `UpdateAgent` with capabilities=Some(["beta"])
- `GetAgentsByCapability("alpha")` → [] (deindexed)
- `GetAgentsByCapability("beta")` → [agent] (indexed)

---

## Section 13: UpdateAgent Partial Updates (5 cases)

**Goal:** Verify that `None` fields in AgentUpdate leave existing values untouched.

**TC-V2-13-01: Update only hub_handle, other fields unchanged**
- Register: hub_handle="original", caps=["cap1"], description="original desc"
- UpdateAgent: hub_handle=Some("updated"), caps=None, description=None, endpoint_hint=None
- GetAgent → hub_handle="updated", capabilities=["cap1"] (unchanged), description="original desc" (unchanged)

**TC-V2-13-02: Update only capabilities, hub_handle unchanged**
- UpdateAgent: caps=Some(["new-cap"]), others=None
- GetAgent → capabilities=["new-cap"], hub_handle="original" (unchanged)

**TC-V2-13-03: Update only description, caps unchanged**
- UpdateAgent: description=Some("new desc"), others=None
- GetAgent → description="new desc", capabilities unchanged, index unchanged

**TC-V2-13-04: Update with all None fields → no-op but Ok**
- UpdateAgent: all fields=None
- Expected: `Ok(())`
- GetAgent → all fields identical to before

**TC-V2-13-05: UpdateAgent description truncation**
- UpdateAgent: description=Some("X"×600)
- GetAgent → description.length=512 (truncated silently)

---

## Section 14: Cross-Program Chain — State Propagation (8 cases)

**Goal:** Verify that cross-program calls correctly propagate state between PriceConsumer/AgentConsumer and VaraCore, and that caches persist correctly.

**TC-V2-14-01: FetchPriceFromOracle propagates exact price from VaraCore**
- VaraCore: UpdatePrice("BTC/USD", 7_540_000_000_000, ...)
- PriceConsumer.FetchPriceFromOracle("BTC/USD") → `Ok(7_540_000_000_000)`
- PriceConsumer.GetCachedPrice() → `("BTC/USD", 7_540_000_000_000)`
- Price cached exactly; u128 precision preserved across cross-program boundary

**TC-V2-14-02: Cache persists across queries (idempotent GetCachedPrice)**
- After FetchPriceFromOracle: GetCachedPrice() called 5 times → same result each time

**TC-V2-14-03: FetchPriceFromOracle updates cache (old cache replaced)**
- Fetch "BTC/USD" at price=A → GetCachedPrice=("BTC/USD", A)
- VaraCore updates BTC/USD to price=B
- Fetch "BTC/USD" again → GetCachedPrice=("BTC/USD", B) (cache replaced)

**TC-V2-14-04: FetchPriceFromOracle for different asset updates both cache fields**
- Fetch "BTC/USD" → GetCachedPrice=("BTC/USD", A)
- Fetch "ETH/USD" → GetCachedPrice=("ETH/USD", B) — both last_asset and last_price updated

**TC-V2-14-05: CheckAgentTrust propagates exact score from VaraCore**
- VaraCore.RecordInteraction(agent, true) → 1 success → ScoreAgent=500
- AgentConsumer.CheckAgentTrust(agent) → `Ok(500)`
- AgentConsumer.GetCachedScore() → `500`

**TC-V2-14-06: FindOracleAgents returns exact count from Registry**
- VaraCore: Register 2 agents with "price-feed" capability
- AgentConsumer.FindOracleAgents() → `Ok(2)`
- AgentConsumer.GetCachedDiscoveryCount() → `2`

**TC-V2-14-07: Prefix decode correctness — FetchPriceFromOracle skips exactly 16 bytes**
- Reply payload from VaraCore: [16-byte "Oracle"+"GetPrice" prefix] + [SCALE Result<OracleData,String>]
- PriceConsumer code skips `PREFIX=16` bytes, decodes from byte 16 onward
- Verify: No decode error; correct OracleData fields extracted

**TC-V2-14-08: Prefix decode correctness — CheckAgentTrust skips exactly 22 bytes**
- Reply payload: [22-byte "Reputation"+"ScoreAgent" prefix] + [SCALE Result<ReputationData,String>]
- AgentConsumer code skips `PREFIX=22` bytes
- Verify: Correct score extracted from ReputationData.score field (5th field, offset within SCALE)

---

## Pass/Fail Criteria

| Section | Cases | Pass Threshold |
|---------|-------|---------------|
| 1: UpdatePrice State Machine | 8 | 8/8 |
| 2: TWAP Ring Buffer | 10 | 10/10 |
| 3: IsStale Boundaries | 6 | 6/6 |
| 4: Score Formula Isolation | 12 | 12/12 |
| 5: Score at Log2 Boundaries | 12 | 12/12 |
| 6: Mixed Success Rate | 6 | 6/6 |
| 7: History Cap | 6 | 6/6 |
| 8: History Window | 5 | 5/5 |
| 9: GetTopAgents | 6 | 6/6 |
| 10: DiscoveryFilter Combos | 16 | 16/16 |
| 11: Active_Only Boundary | 6 | 6/6 |
| 12: Re-Registration | 5 | 5/5 |
| 13: Partial Update | 5 | 5/5 |
| 14: Cross-Program Chain | 8 | 8/8 |
| **Total** | **111** | **111/111** |

**PASS** = All 111 cases pass
**V2 FAIL** = Investigate formula or state machine bug before proceeding to V3
