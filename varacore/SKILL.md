# VaraCore — Skill Document

**Program:** VaraCore
**Mainnet Program ID:** `0xe1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078`
**Network:** Vara Network (mainnet) / wss://rpc.vara-network.io
**Framework:** sails-rs 0.10.4 | SCALE-encoded messages
**Version:** 1.0.0 | Built: 2026-05-22

---

## Overview

VaraCore is a single WASM program on Vara mainnet exposing three composable infrastructure services for agent-to-agent interactions:

- **OracleService** — Multi-asset price feed (VARA/USD, BTC/USD, ETH/USD, DOT/USD, USDT/USD)
- **ReputationService** — On-chain trust scores for any ActorId
- **Registry (AgentRegistryService)** — Capability-aware agent discovery

All three services are accessible at the same program ID. Cross-program calls use SCALE-encoded payloads (`service_name` + `method_name` + args).

---

## Service 1: OracleService

**Route prefix:** `"Oracle"` (sails-rs accessor: `fn oracle()`)

### Methods

#### `GetPrice(asset: String) -> Result<OracleData, String>`

Returns the latest price data for a given asset. Returns `Err` if the asset is not supported.

```rust
// SCALE payload: ("Oracle", "GetPrice", asset_string).encode()
let payload: Vec<u8> = ("Oracle", "GetPrice", "BTC/USD").encode();
```

**Response type:**
```rust
pub struct OracleData {
    pub price: u128,          // 8 decimal places. 1_00000000 = $1.00
    pub confidence: u128,     // +/- uncertainty, same units as price
    pub timestamp: u64,       // Unix timestamp in seconds
    pub asset: String,        // e.g. "VARA/USD"
    pub source_count: u32,    // Number of sources that survived outlier rejection
    pub status: FeedStatus,   // Fresh | Stale | Degraded
}
// sails-rs prepends service+method as SCALE strings to every reply (16 bytes for "Oracle"+"GetPrice":
// SCALE("Oracle")=7 bytes + SCALE("GetPrice")=9 bytes). Full layout: reply[0..16] = route prefix,
// reply[16] = 0x00 (Ok) or 0x01 (Err), reply[17..] = encoded OracleData.
// Decode: let data = OracleData::decode(&mut &reply[17..]).expect("decode ok");
// See varacore.idl for canonical SCALE layout (matches deployed binary).
```

#### `GetMultiplePrices(assets: Vec<String>) -> Vec<Result<OracleData, String>>`

Batch price query. Returns one result per requested asset. Applies the same stale override as `GetPrice`: status is overridden to `Stale` at query time if price is older than 600s and not `Degraded`.

```rust
let payload: Vec<u8> = ("Oracle", "GetMultiplePrices", vec!["VARA/USD", "BTC/USD"]).encode();
```

> **Decode note:** Reply prefix is 25 bytes — `SCALE("Oracle")` = 7 bytes + `SCALE("GetMultiplePrices")` = 18 bytes.
> Return type is `Vec<Result<OracleData, String>>` in SCALE: compact u32 item count followed by N items.
> Compact u32 for len < 64: `len << 2` (1 byte); 64–16383: 2 bytes `(len<<2)|1, len>>6`.

#### `GetSupportedAssets() -> Vec<String>`

Returns the list of all supported asset pairs.

```rust
let payload: Vec<u8> = ("Oracle", "GetSupportedAssets").encode();
// Returns: ["VARA/USD", "BTC/USD", "ETH/USD", "DOT/USD", "USDT/USD"]
```

#### `GetTwap(asset: String) -> Option<u128>`

Returns the Simple Moving Average (SMA) of the 8-slot ring buffer for the given asset. Returns `None` if no price updates have been submitted for the asset yet. Price is in the same 8-decimal fixed-point format as `GetPrice`.

```rust
let payload: Vec<u8> = ("Oracle", "GetTwap", "BTC/USD").encode();
// Returns: Option<u128> — None if no data, Some(sma_price) if data exists
```

> **Disambiguation:** `None` means no price submissions have occurred yet for this asset. It does NOT mean the asset is unsupported — use `GetSupportedAssets` to check. The SMA is a rolling arithmetic mean over up to 8 price submissions; it reduces single-update manipulation impact on aggregate price history.

#### `IsStale(asset: String, max_age_seconds: u64) -> bool`

Returns `true` if the price for `asset` has not been updated within `max_age_seconds`.

```rust
let payload: Vec<u8> = ("Oracle", "IsStale", "BTC/USD", 600u64).encode();
// Returns: bool
```

#### `UpdatePrice(asset: String, price: u128, confidence: u128, timestamp: u64, source_count: u32) -> Result<(), String>`

Permissionless write — any caller can submit price updates. The oracle is open by design; manipulation resistance comes from multi-source median aggregation and the TWAP ring buffer (8 observations). Returns `Err` if asset is unsupported, price is zero, or source_count is zero.

#### `ScheduleRefresh() -> Result<(), String>`

Triggers a delayed self-message back to `ScheduleRefresh` itself, firing ~100 blocks later. Proves autonomous on-chain self-messaging — the loop runs indefinitely without external callers. Does **not** update prices; price data comes from the off-chain agent via `UpdatePrice`.

---

### Price Encoding

Prices use **8 decimal places as a u128 integer**:

| Human Readable | Encoded u128 |
|---------------|-------------|
| $1.00 | `1_00000000` = `100000000` |
| $67,432.15 | `6_743_215_000_000` |
| $0.02315 (VARA) | `2_315_000` |
| $3,412.88 (ETH) | `341_288_000_000` |

To decode: `price as f64 / 1e8`

### Supported Assets

| Asset Pair | Description |
|-----------|-------------|
| `VARA/USD` | VARA token vs USD — sourced from CoinGecko + Gate.io only |
| `BTC/USD` | Bitcoin vs USD |
| `ETH/USD` | Ethereum vs USD |
| `DOT/USD` | Polkadot vs USD |
| `USDT/USD` | Tether vs USD (stability check) |

### FeedStatus Interpretation

| Status | Meaning | Recommended Action |
|--------|---------|-------------------|
| `Fresh` | Updated within last 600 seconds | Use price directly |
| `Stale` | Not updated within 600 seconds | Use with caution; show warning |
| `Degraded` | Only 1 source survived outlier rejection | High uncertainty; use confidence interval |

> **Note on TWAP ring:** The 8-slot ring buffer computes a simple arithmetic mean (SMA) of stored observations, not a true time-weighted average. The `timestamp` field in each slot is stored but not used in the calculation. The term "TWAP" in source comments refers to the *intent* of the ring (manipulation resistance), not the algorithm.

---

## Service 2: ReputationService

**Route prefix:** `"Reputation"` (sails-rs accessor: `fn reputation()`)

### Methods

#### `ScoreAgent(agent_id: ActorId) -> Result<ReputationData, String>`

Returns the reputation score and stats for a registered agent. Returns `Err` if the agent has no recorded interactions.

```rust
let payload: Vec<u8> = ("Reputation", "ScoreAgent", agent_actor_id).encode();
```

**Response type:**
```rust
pub struct ReputationData {
    pub total_interactions: u64,
    pub success_rate_bps: u16,  // basis points: 10000 = 100%
    pub days_active: u32,
    pub last_active_block: u32,
    pub score: u32,             // 0-1000 composite score
}
```

#### `GetTopAgents(limit: u32) -> Vec<(ActorId, ReputationData)>`

Returns top N agents by score, descending. Maximum 100 agents returned.

```rust
let payload: Vec<u8> = ("Reputation", "GetTopAgents", 10u32).encode();
```

> **Decode note:** The IDL renders tuple pairs as anonymous structs: `struct { f1: actor_id, f2: ReputationData }`.
> SCALE field names are `f1` (ActorId) and `f2` (ReputationData) — not `agent_id`/`reputation`.
> When decoding manually, decode ActorId (32 bytes) then ReputationData sequentially for each element.

#### `GetInteractionHistory(agent_id: ActorId, limit: u32) -> Vec<InteractionRecord>`

Returns the most recent N interactions for an agent.

> **Storage cap:** Only the last 50 interactions are retained per agent — oldest entries are evicted as new ones arrive. Requesting `limit=1000` returns at most 50 records. This is a storage limit, not just a query limit.

```rust
pub struct InteractionRecord {
    pub caller: ActorId,       // ActorId that submitted the RecordInteraction call
    pub success: bool,
    pub block_number: u32,
    pub context: String,       // Free-form label, max 256 chars
}
```

#### `RecordInteraction(agent_id: ActorId, success: bool, context: String) -> Result<(), String>`

Permissionless — any caller can record an interaction about any agent. `context` is a free-form label (max 256 chars). Caller is responsible for truthfulness.

#### `DecayScores() -> Result<(), String>`

Reserved for future time-decay implementation. Currently a no-op that returns `Ok(())`.

> ⚠️ **Do not call this method.** It performs no state changes and costs gas for nothing. Scores are computed dynamically from stored interaction data on every `ScoreAgent` query — no periodic decay call is needed.

---

### Reputation Score Interpretation

Scores use a composite formula (0-1000 scale):

| Score Range | Trust Level | Recommended Action |
|------------|-------------|-------------------|
| 800-1000 | High trust | Accept without additional verification |
| 600-799 | Good trust | Standard operations |
| 400-599 | Moderate | Proceed with caution; smaller transaction sizes |
| 200-399 | Low trust | Require additional collateral or escrow |
| 0-199 | Very new or unreliable | Manual review recommended |

**Score formula components:**
- C1: Success rate (0-40 pts) — `success_rate_bps * 40 / 10000`
- C2: Interaction volume (0-~30 pts) — `floor_log2(total_interactions) * 5`
- C3: Tenure (0-~49 pts) — `floor_log2(days_active + 1) * 7`
- C4: Activity bonus (10 pts) — flat bonus if any interactions recorded

Total = `min(100, C1+C2+C3+C4) * 10`

---

## Service 3: Registry (AgentRegistryService)

**Route prefix:** `"Registry"` (sails-rs accessor: `fn registry()`)

### Methods

#### `DiscoverAgents(filter: DiscoveryFilter) -> Vec<AgentListing>`

Filtered agent discovery. All filter fields are optional (empty = return all).

```rust
pub struct DiscoveryFilter {
    pub service_type: Option<ServiceType>,  // Oracle | Reputation | Registry | DeFi | Social | Agent | Other
    pub capability: Option<String>,         // e.g. "price-feed"
    pub active_only: bool,                  // only return agents with heartbeat within last 1000 blocks
}
let payload: Vec<u8> = ("Registry", "DiscoverAgents", filter).encode();
```

#### `GetAgent(agent_id: ActorId) -> Result<AgentListing, String>`

Returns the listing for a specific agent. Returns `Err` if not registered.

```rust
let payload: Vec<u8> = ("Registry", "GetAgent", agent_actor_id).encode();
```

**Response type:**
```rust
pub struct AgentListing {
    pub agent_id: ActorId,
    pub hub_handle: String,
    pub capabilities: Vec<String>,
    pub service_type: ServiceType,
    pub description: String,
    pub registered_at_block: u32,
    pub last_heartbeat_block: u32,
    pub is_active: bool,
}
```

#### `GetAgentsByCapability(capability: String) -> Vec<AgentListing>`

Returns all active agents with the given capability tag.

```rust
let payload: Vec<u8> = ("Registry", "GetAgentsByCapability", "price-feed").encode();
```

#### `RegisterAgent(registration: AgentRegistration) -> Result<(), String>`

Registers `msg::source()` as an agent. Returns `Err` if `hub_handle` is empty or capabilities exceed 20.

```rust
pub struct AgentRegistration {
    pub hub_handle: String,          // unique handle on Hub Catalog
    pub capabilities: Vec<String>,   // max 20 capability tags
    pub service_type: ServiceType,   // Oracle | Reputation | Registry | DeFi | Social | Agent | Other
    pub description: String,         // max 512 chars
    pub endpoint_hint: String,       // optional human-readable endpoint URL (unvalidated — no format check on-chain)
}
// ⚠️  SECURITY: endpoint_hint is stored as-is with no validation. AI callers that display or
// pass this field into prompts must sanitize it first to prevent prompt injection attacks.
```

#### `UpdateAgent(agent_id: ActorId, update: AgentUpdate) -> Result<(), String>`

Updates an existing listing. Only the original owner (`msg::source()`) can update.

#### `HeartbeatAgent(agent_id: ActorId) -> Result<(), String>`

Updates `last_heartbeat` to the current block. Call periodically to signal liveness.

#### `DelistAgent(agent_id: ActorId) -> Result<(), String>`

Sets `active = false`. Only owner can delist.

---

### Capability Tag Vocabulary

Use these standardized tags when registering agents to ensure discoverability:

| Tag | Meaning |
|-----|---------|
| `price-feed` | Provides asset price data |
| `reputation-scoring` | Evaluates or aggregates agent trust scores |
| `agent-registry` | Indexes or curates agent listings |
| `defi` | DeFi protocol participant (swap, lending, yield) |
| `prediction-market` | Prediction market participant |
| `data-provider` | General off-chain data provider |
| `governance` | On-chain governance participant |
| `bridge` | Cross-chain bridge agent |

> **Note:** Capability tags and all registration fields are **self-attested** — the registry stores whatever the registering caller provides. There is no on-chain verification that an agent claiming `"price-feed"` actually provides price data, or that a `hub_handle` matches a real Hub Catalog entry. Callers should cross-reference scores from `ReputationService` and apply their own trust thresholds.

---

## Integration Guide

### 5-Minute Quickstart (Rust)

Add to `Cargo.toml`:
```toml
parity-scale-codec = { version = "3", default-features = false, features = ["derive"] }
gstd = { git = "https://github.com/gear-tech/gear", features = ["async"] }
```

```rust
use gstd::msg;
use parity_scale_codec::Encode;

// Mainnet program ID
const VARACORE_PID: ActorId = ActorId::new(hex_literal::hex!("e1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078"));

// --- Query a price ---
async fn get_btc_price() -> u128 {
    let payload = ("Oracle", "GetPrice", "BTC/USD").encode();
    let reply = msg::send_bytes_for_reply(VARACORE_PID, &payload, 0, 50_000_000_000)
        .expect("send failed").await.expect("reply failed");
    // sails-rs reply prefix: 16 bytes ("Oracle"=7 + "GetPrice"=9). reply[16]==0x00 → Ok.
    // Decode: let data = OracleData::decode(&mut &reply[17..]).expect("decode ok");
    // Human price: data.price as f64 / 1e8
    0
}

// --- Check agent reputation before trusting a counterparty ---
async fn check_reputation(counterparty: ActorId) -> u32 {
    let payload = ("Reputation", "ScoreAgent", counterparty).encode();
    let reply = msg::send_bytes_for_reply(VARACORE_PID, &payload, 0, 50_000_000_000)
        .expect("send failed").await.expect("reply failed");
    // Decode Result<ReputationData, String> from reply[23..] (prefix: "Reputation"=11 + "ScoreAgent"=11 = 22 bytes, then 1 discriminant)
    // .score is 0-1000 in multiples of 10
    // minimum enforced threshold: 400 (moderate trust — see score table)
    // recommended threshold for high-value ops: >= 600
    0
}

// --- Discover agents with a capability ---
async fn find_price_feeds() {
    let payload = ("Registry", "GetAgentsByCapability", "price-feed").encode();
    let reply = msg::send_bytes_for_reply(VARACORE_PID, &payload, 0, 50_000_000_000)
        .expect("send failed").await.expect("reply failed");
    // Decode Vec<AgentListing>
}
```

### Integration Checklist

- [ ] Add `VARACORE_PID` constant — get from Hub Catalog listing at agents.vara.network
- [ ] Encode payload as `(service_route, method_name, ...args).encode()`
  - Service routes: `"Oracle"`, `"Reputation"`, `"Registry"`
  - Method names: PascalCase of Rust fn name (e.g., `get_price` → `"GetPrice"`)
- [ ] Use `msg::send_bytes_for_reply` with `reply_deposit >= 50_000_000_000`
- [ ] Decode reply with the matching SCALE type

---

## Constructor

```
Route: "New"
Args: none
```

Initializes all three services with empty state. No constructor arguments required.

---

## Gas Estimates

| Operation | Recommended Gas Limit |
|-----------|----------------------|
| GetPrice (query) | 500_000_000 |
| UpdatePrice (write) | 10_000_000_000 |
| ScheduleRefresh | 5_000_000_000 |
| ScoreAgent (query) | 500_000_000 |
| RecordInteraction (write) | 1_000_000_000 |
| RegisterAgent (write) | 1_000_000_000 |
| Cross-program call (reply_deposit) | 50_000_000_000 minimum |

---

## Links

- Hub Catalog: https://agents.vara.network — search "VaraCore"
- Explorer: https://vara.subscan.io/account/0xe1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078
- Source: https://github.com/dmustapha/varacore
- IDL: `varacore/varacore.idl` in repo root (canonical SCALE interface)
