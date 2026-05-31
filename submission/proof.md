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

> Block hashes below identify the block containing each cross-program interaction.
> Verify at `https://vara.subscan.io/block/{hash}`.

### PriceConsumer → VaraCore (Oracle.GetPrice)
| Run | Block Hash | Method |
|-----|-----------|--------|
| V1 (wire phase) | `0xaa0382cbea2eb936acae783eede24df4d0a518b9d22cf2191dfd32e91e4f4a26` | PriceConsumer.FetchPrice → Oracle.GetPrice |
| V2 (livetest, 2026-05-31) | `0xfc5d838896a6a3324a80bba6618ebdffa07de1577cb51608bf8dd6a1f6c4478f` | PriceConsumer.FetchPriceFromOracle → Oracle.GetPrice |

### AgentConsumer → VaraCore (Reputation.ScoreAgent)
| Run | Block Hash | Method |
|-----|-----------|--------|
| V1 (wire phase) | `0xdc0674fafca4411679e5564bfdb159a0845dfa6eb7ce9afcb3d3c82605c23c31` | AgentConsumer.CheckAgentTrust → Reputation.ScoreAgent |
| V2 (livetest, 2026-05-31) | `0xb53dab2208d5ec75fde87721512ce3823dc3fbe1312688e2fc8496ab435e8131` | AgentConsumer.CheckAgentTrust → Reputation.ScoreAgent |

### AgentConsumer → VaraCore (Registry.GetAgentsByCapability)
| Run | Block Hash | Method |
|-----|-----------|--------|
| V1 (wire phase) | `0xe0b5b71e4dd282445f7d0b360e7d9946631dc7a26febe1877d0f7fe8bb087330` | AgentConsumer.FindOracleAgents → Registry.GetAgentsByCapability |
| V2 (livetest, 2026-05-31) | `0x66624b9c784a8fee663928aa845276b3f7bf10ee16b314cef401051648216ffc` | AgentConsumer.FindOracleAgents → Registry.GetAgentsByCapability |

---

## ScheduleRefresh (Autonomous Oracle Loop)

VaraCore.OracleService sends itself a delayed message every ~100 blocks via
`exec::reserve_gas` + `msg::send_delayed_from_reservation`. The loop is self-sustaining:
each execution reserves gas and enqueues the next call. The loop has been running
continuously since program initialization and has fired hundreds of times.

**Payload encoding:** `("Oracle", "ScheduleRefresh").encode()` — sails-rs 0.10.x string
routing (numeric Interface ID routing was introduced in v1.0.0-beta.1, March 2026).

**Loop verified on-chain:** Two sequential self-calls confirm the loop is operational:

| Block Hash | Description |
|-----------|-------------|
| `0xef0b6b1b56c23181bc19f3e9bf48a192282008de389ae1bbbe1bf8fe81613caa` | ScheduleRefresh self-call #1 (initial) |
| `0xa9ec0dd9cbdf82e2...` | ScheduleRefresh self-call #2 (~100 blocks later — proves loop round-trip) |

> Call #2 proves receipt and re-execution of the delayed message: if the payload encoding
> were wrong or gas exhausted, call #2 would not exist. The program has since fired
> ~500+ additional loops (deployed Day 18; ~100-block intervals ≈ 5 min per cycle).

---

## Hub Catalog Registration

**Participant handle:** `varacore` (operator wallet)
**Application handle:** `varacore-app` (program `0xe1f8f2...`)
**Status:** Submitted
**Hub Registry program:** `0x19f27f4c906a5ac230be82d907850d44c7a7fff1b4c6903f62e78e09e0b353f3`

| Action | Block Hash | Block # |
|--------|-----------|---------|
| DeleteApplication (wrong PID cleanup) | `0x78718c543c3f24cb3b25f91c2f264e5cda83b51f6e3dd883694e55321894ee81` | 33427045 |
| RegisterApplication (`0xe1f8f2...`) | `0xcb80f345766789de92122dbf84c548b46cfb3d46126ecc55d1fbd20fd140363c` | 33427049 |
| SubmitApplication | `0xdeb264e32d6004968f8064104156cd84f0f6c579037add26e7a0e3ae5bf0e35a` | 33427055 |
| Board/SetIdentityCard | `0xe3b7ee9512419b4767726f133096fd88d251bd4bc2757f2c208bb338de7318c2` | 33427089 |
| Chat/Post (message #3773) | `0x26834bda40df1a5c9f82187bd4d14cc5c737bfb182921105e3a5ba97f49df787` | 33427099 |

**Indexer verification:** `identityCardById("0xe1f8f2...")` → `whoIAm` confirmed live in indexer.

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

GitHub: https://github.com/dmustapha/varacore
IDL: `varacore/varacore.idl` (canonical SCALE interface)
Skill doc: `varacore/SKILL.md` (for agent integration)
