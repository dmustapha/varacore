# VaraCore: Agent Trust Infrastructure for Vara Network

Three composable services in one Sails program: price oracle, reputation scorer, and agent registry. Any Vara agent can call all three at the same address.

[![Rust](https://img.shields.io/badge/Rust-1.75-orange?logo=rust)](https://www.rust-lang.org/)
[![Sails](https://img.shields.io/badge/Sails-0.10.4-purple)](https://github.com/gear-tech/sails)
[![Network](https://img.shields.io/badge/Network-Vara%20Mainnet-blue)](https://vara.network)
[![Tests](https://img.shields.io/badge/tests-54%20unit%20%7C%2093%20mainnet-brightgreen)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Mainnet:** `0xe1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078`
**Hub Catalog:** [agents.vara.network](https://agents.vara.network) (search "VaraCore")
**Explorer:** [vara.subscan.io](https://vara.subscan.io/account/0xe1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078)

---

## What Is VaraCore?

VaraCore is a shared infrastructure program on Vara mainnet. It gives every agent on the network three things it needs to operate autonomously: current asset prices, a trust score for any counterparty, and a searchable registry of agents by capability.

Any Vara program can call VaraCore with a single SCALE-encoded message. No API keys, no authentication. One program ID, three services, permanently on-chain.

---

## Services

### OracleService: Multi-asset price feed

Tracks VARA/USD, BTC/USD, ETH/USD, DOT/USD, and USDT/USD. Prices are u128 with 8 decimal places (`1_00000000` = $1.00). Multiple independent sources are aggregated; outlier rejection and a TWAP ring buffer (8 observations) smooth manipulation attempts.

```rust
let payload = ("Oracle", "GetPrice", "BTC/USD").encode();
// Returns: Result<OracleData, String>
// OracleData { price: u128, confidence: u128, timestamp: u64,
//              asset: String, source_count: u32, status: FeedStatus }
// Human price: data.price as f64 / 1e8
```

### ReputationService: On-chain trust scores

Any caller can record a success or failure for any agent. Scores (0–1000) are computed from success rate, interaction volume, and account age. Useful before accepting a counterparty or deciding how much collateral to require.

```rust
let payload = ("Reputation", "ScoreAgent", agent_actor_id).encode();
// Returns: Result<ReputationData, String>
// score >= 600 = trusted for standard operations
```

### AgentRegistryService: Capability-aware agent discovery

Agents register with tags (e.g., `"price-feed"`, `"defi"`, `"governance"`). Other agents query by capability or service type, filtering for active agents only.

```rust
let payload = ("Registry", "DiscoverAgents", filter).encode();
// Returns: Vec<AgentListing>
```

---

## Features

- **Single address, three services:** one `VARACORE_PID` constant covers oracle, reputation, and registry
- **Permissionless writes:** any caller can submit price data or record interactions; manipulation resistance comes from aggregation, not access control
- **Cross-program native:** designed for Sails `msg::send_bytes_for_reply` calls from other programs
- **SCALE-encoded interface:** IDL in `varacore/varacore.idl`; fully language-agnostic
- **Permanent on-chain state:** programs on Vara are immutable; VaraCore runs indefinitely
- **Off-chain agent:** TypeScript price-feeder pulls CoinGecko/Binance/Gate.io, aggregates, and calls `UpdatePrice` every ~100 blocks via `ScheduleRefresh`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| On-chain program | Rust + Sails 0.10.4 (WASM) |
| Network | Vara Network (Gear Protocol) |
| Encoding | SCALE (parity-scale-codec 3.x) |
| Off-chain agent | TypeScript + @gear-js/api 0.44 |
| Price sources | CoinGecko, Binance, Gate.io |
| Deploy tool | Vara Wallet CLI (gcli) |

---

## Integration (5 minutes)

Add to `Cargo.toml`:
```toml
parity-scale-codec = { version = "3", default-features = false, features = ["derive"] }
gstd = { git = "https://github.com/gear-tech/gear", features = ["async"] }
```

```rust
use gstd::msg;
use parity_scale_codec::Encode;

const VARACORE: ActorId = ActorId::new(hex_literal::hex!(
    "e1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078"
));

// Query a price
let payload = ("Oracle", "GetPrice", "BTC/USD").encode();
let reply = msg::send_bytes_for_reply(VARACORE, &payload, 0, 2_000_000_000)
    .expect("send failed").await.expect("reply failed");
// reply[0] == 0x00 → Ok; decode OracleData from reply[1..]

// Check agent reputation
let payload = ("Reputation", "ScoreAgent", counterparty).encode();

// Discover agents by capability
let payload = ("Registry", "GetAgentsByCapability", "price-feed").encode();
```

See [`varacore/SKILL.md`](varacore/SKILL.md) for complete method signatures, response types, gas estimates, and decoding examples.

**SCALE payload format:** `(service_route, method_name, ...args).encode()`

| Service | Route | Gas (query) | Gas (write) |
|---------|-------|-------------|-------------|
| OracleService | `"Oracle"` | 500_000_000 | 2_000_000_000 |
| ReputationService | `"Reputation"` | 500_000_000 | 1_000_000_000 |
| AgentRegistryService | `"Registry"` | 500_000_000 | 1_000_000_000 |

---

## Companion Programs (Live Cross-Program Calls)

Two demo programs deployed on Vara mainnet call VaraCore directly, proving the integration works:

| Program | Address | Calls |
|---------|---------|-------|
| PriceConsumer | `0xc6836012...` | Oracle.GetPrice |
| AgentConsumer | `0xc12b0063...` | Reputation.ScoreAgent + Registry.DiscoverAgents |

---

## How It Works

```
Off-chain price-feeder agent (TypeScript)
  |
  +---> CoinGecko / Binance / Gate.io (3 sources)
  |     Outlier rejection → median aggregation
  |
  +---> Oracle.UpdatePrice (SCALE call, every ~100 blocks)
  |     ScheduleRefresh loop keeps prices fresh
  |
  +---> VaraCore WASM program (Vara mainnet)
          |
          +---> OracleService (TWAP + FeedStatus)
          +---> ReputationService (interaction log + score)
          +---> AgentRegistryService (capability index)
                       |
                       v
          Any Vara agent calls any service
          via msg::send_bytes_for_reply
```

---

## Running Locally

```bash
# Build the WASM program
cargo build --release --target wasm32-unknown-unknown

# Run tests
cargo test -p varacore  # 54 tests

# Run the off-chain price agent
cd agent
cp .env.example .env    # fill in VARA_ENDPOINT, VARACORE_PROGRAM_ID, mnemonic
npm install
npm run price-agent
```

### Required environment variables (agent/.env)

```bash
VARA_ENDPOINT=wss://rpc.vara.network
VARACORE_PROGRAM_ID=0xe1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078
PRICE_AGENT_MNEMONIC=...     # funded Vara account
PRICE_CONSUMER_ID=0x...      # companion program address
AGENT_CONSUMER_ID=0x...      # companion program address
```

---

## Project Structure

```
varacore/
  src/
    oracle.rs       # OracleService — price feed, TWAP, FeedStatus
    reputation.rs   # ReputationService — interaction log, composite score
    registry.rs     # AgentRegistryService — capability index, discovery
    lib.rs          # Program entry + service wiring
  varacore.idl      # Canonical SCALE interface (IDL)
  SKILL.md          # Hub Catalog skill document (integration reference)
price-consumer/     # Demo companion: calls OracleService
agent-consumer/     # Demo companion: calls Reputation + Registry
agent/
  src/
    price-agent.ts          # Continuous price update loop
    register-hub.ts         # Hub Catalog registration
    register-test-agents.ts # Pre-register demo agents
    seed-interactions.ts    # Pre-seed reputation data
  .env.example
submission/
  proof.md          # On-chain transaction proof
```

---

## License

MIT
