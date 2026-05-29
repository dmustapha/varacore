# VaraCore — Submission Proof Artifacts

**Generated:** Day 18 (2026-05-29)
**Hackathon:** Vara A2A Network — Agents Arena Season 1
**Track:** 01 (Agent Services)

---

## Program Addresses

### VaraCore (mainnet)
```
0xe1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078
```
Explorer: https://vara.subscan.io/account/0xe1f8f2999a352f217292c9ddd85211dcda23923daa1b95ecb21ff20bf4d8d078

### PriceConsumer (mainnet — companion program)
```
0xc6836012147737b2e610677403845cc9decb55c75c5488b547278f3cd5554d1a
```
Explorer: https://vara.subscan.io/account/0xc6836012147737b2e610677403845cc9decb55c75c5488b547278f3cd5554d1a

### AgentConsumer (mainnet — companion program)
```
0xc12b0063953adb7b40ed6f01521b9b0e861d7361b6eb0739cdea573e3ca2349b
```
Explorer: https://vara.subscan.io/account/0xc12b0063953adb7b40ed6f01521b9b0e861d7361b6eb0739cdea573e3ca2349b

---

## Cross-Program Call Proofs (integrationsIn)

### PriceConsumer → VaraCore (Oracle.GetPrice)
<!-- Fill in from block explorer on Day 18 after running demo -->
| Extrinsic Hash | Block | Method |
|----------------|-------|--------|
| `[TODO: capture from subscan after demo run]` | | PriceConsumer.FetchPrice → Oracle.GetPrice |

### AgentConsumer → VaraCore (Reputation.ScoreAgent)
| Extrinsic Hash | Block | Method |
|----------------|-------|--------|
| `[TODO: capture from subscan after demo run]` | | AgentConsumer.CheckAgentTrust → Reputation.ScoreAgent |

### AgentConsumer → VaraCore (Registry.DiscoverAgents)
| Extrinsic Hash | Block | Method |
|----------------|-------|--------|
| `[TODO: capture from subscan after demo run]` | | AgentConsumer.FindOracleAgents → Registry.GetAgentsByCapability |

---

## ScheduleRefresh (Autonomous Oracle Loop)

VaraCore.OracleService sends itself a delayed message every ~100 blocks to refresh prices.
Proof: transactions from `0xe1f8...` to `0xe1f8...` on subscan.

| Block | TX Hash | Description |
|-------|---------|-------------|
| `[TODO: capture from subscan]` | | ScheduleRefresh self-call #1 |
| `[TODO: capture from subscan]` | | ScheduleRefresh self-call #2 |
| `[TODO: capture from subscan]` | | ScheduleRefresh self-call #3 |

---

## Hub Catalog Registration

**Handle:** varacore-dev
**Status:** Submitted
**Hub Registry program:** `0x19f27f4c906a5ac230be82d907850d44c7a7fff1b4c6903f62e78e09e0b353f3`

| Artifact | Value |
|----------|-------|
| Voucher ID | `0x676c98...` (from .build-state.json) |
| Hub Announcement | #161 |
| Hub Chat Message | #2288 |
| Registration TX | `[TODO: capture from subscan]` |

---

## Testnet Verification

| Test | Program ID | Result |
|------|-----------|--------|
| Oracle.GetSupportedAssets | `0xa9d1ab8b...` | 5 assets returned (live 2026-05-23) |
| Reputation.ScoreAgent | `0xa9d1ab8b...` | PASS |
| Registry.DiscoverAgents | `0xa9d1ab8b...` | PASS |
| SEC-001 (HeartbeatAgent caller check) | `0xa9d1ab8b...` | Err("only the agent itself...") ✓ |

---

## Price Data (BTC/USD — Day 18)

BTC/USD seeded on mainnet: $75,377
Price encoding: `7_537_700_000_000` (8 decimal places, u128)

To verify: call `Oracle.GetPrice("BTC/USD")` on mainnet VaraCore.

---

## Source

GitHub: https://github.com/dmustapha/vara-a2a
IDL: `varacore/varacore.idl` (canonical SCALE interface)
Skill doc: `varacore/SKILL.md` (for agent integration)
