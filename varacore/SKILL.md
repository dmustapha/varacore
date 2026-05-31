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
- **AgentRegistryService** — Capability-aware agent discovery

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
// Decode with OracleData::decode(&mut &reply[1..]) after stripping the 1-byte Result discriminant.
// See varacore.idl for canonical SCALE layout (matches deployed binary).
```

#### `GetMultiplePrices(assets: Vec<String>) -> Vec<Result<OracleData, String>>`

Batch price query. Returns one result per requested asset.

```rust
let payload: Vec<u8> = ("Oracle", "GetMultiplePrices", vec!["VARA/USD", "BTC/USD"]).encode();
```

#### `GetSupportedAssets() -> Vec<String>`

Returns the list of all supported asset pairs.

```rust
let payload: Vec<u8> = ("Oracle", "GetSupportedAssets").encode();
// Returns: ["VARA/USD", "BTC/USD", "ETH/USD", "DOT/USD", "USDT/USD"]
```

#### `IsStale(asset: String, max_age_seconds: u64) -> bool`

Returns `true` if the price for `asset` has not been updated within `max_age_seconds`.

```rust
let payload: Vec<u8> = ("Oracle", "IsStale", "BTC/USD", 600u64).encode();
// Returns: bool
```

#### `UpdatePrice(asset: String, price: u128, confidence: u128, timestamp: u64, source_count: u32) -> Result<(), String>`

Permissionless write — any caller can submit price updates. The oracle is open by design; manipulation resistance comes from multi-source median aggregation and the TWAP ring buffer (8 observations). Returns `Err` if asset is unsupported, price is zero, or source_count is zero.

#### `ScheduleRefresh() -> Result<(), String>`

Triggers a delayed self-message that fires ~100 blocks later to refresh prices. Called by the oracle agent to set up an autonomous update loop.

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

#### `GetInteractionHistory(agent_id: ActorId, limit: u32) -> Vec<InteractionRecord>`

Returns the most recent N interactions for an agent. Maximum 50 per query.

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

## Service 3: AgentRegistryService

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
    pub endpoint_hint: String,       // optional human-readable endpoint URL
}
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
    let reply = msg::send_bytes_for_reply(VARACORE_PID, &payload, 0, 2_000_000_000)
        .expect("send failed").await.expect("reply failed");
    // reply[0] == 0x00 → Ok; reply[1..] is SCALE-encoded OracleData
    // Decode: let data = OracleData::decode(&mut &reply[1..]).expect("decode ok");
    // Human price: data.price as f64 / 1e8
    0
}

// --- Check agent reputation before trusting a counterparty ---
async fn check_reputation(counterparty: ActorId) -> u32 {
    let payload = ("Reputation", "ScoreAgent", counterparty).encode();
    let reply = msg::send_bytes_for_reply(VARACORE_PID, &payload, 0, 2_000_000_000)
        .expect("send failed").await.expect("reply failed");
    // Decode Result<ReputationData, String>
    // .score is 0-1000; >= 600 = trusted
    0
}

// --- Discover agents with a capability ---
async fn find_price_feeds() {
    let payload = ("Registry", "GetAgentsByCapability", "price-feed").encode();
    let reply = msg::send_bytes_for_reply(VARACORE_PID, &payload, 0, 2_000_000_000)
        .expect("send failed").await.expect("reply failed");
    // Decode Vec<AgentListing>
}
```

### Integration Checklist

- [ ] Add `VARACORE_PID` constant — get from Hub Catalog listing at agents.vara.network
- [ ] Encode payload as `(service_route, method_name, ...args).encode()`
  - Service routes: `"Oracle"`, `"Reputation"`, `"Registry"`
  - Method names: PascalCase of Rust fn name (e.g., `get_price` → `"GetPrice"`)
- [ ] Use `msg::send_bytes_for_reply` with `reply_deposit >= 2_000_000_000`
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
| UpdatePrice (write) | 2_000_000_000 |
| ScheduleRefresh | 5_000_000_000 |
| ScoreAgent (query) | 500_000_000 |
| RecordInteraction (write) | 1_000_000_000 |
| RegisterAgent (write) | 1_000_000_000 |
| Cross-program call (reply_deposit) | 2_000_000_000 minimum |

---

## Links

- Hub Catalog: https://agents.vara.network — search "VaraCore"
- Explorer: https://vara.subscan.io/account/0xe1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078
- Source: https://github.com/dmustapha/varacore
- IDL: `varacore/varacore.idl` in repo root (canonical SCALE interface)
