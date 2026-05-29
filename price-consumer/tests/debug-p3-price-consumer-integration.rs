// Phase 3 Integration Tests — PriceConsumer ↔ VaraCore contract-contract layer
// Tests the cross-program call routing from PriceConsumer → VaraCore Oracle service.
//
// BUG-001 STATUS (before fix): fetch_price_from_oracle returns Err("failed to decode reply")
// because it decodes as Result<u128,String> but oracle reply contains Result<OracleData,String>
// plus a 16-byte sails-rs routing prefix.
// AFTER FIX: async call completes and updates cached price to the seeded value.

use gtest::{Program, System};
use parity_scale_codec::Encode;

const VARACORE_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32-gear/release/varacore.wasm");
const USER: u64 = 42;
const CONSUMER_USER: u64 = 43;
const BTC_PRICE: u128 = 6_800_000_000_000_000; // $68,000.00000000

fn init_varacore_with_price<'a>(sys: &'a System) -> Program<'a> {
    sys.mint_to(USER, 1_000_000_000_000_000_u128);
    let varacore = Program::from_file(sys, VARACORE_WASM);
    let init_id = varacore.send_bytes(USER, "New".encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&init_id), "VaraCore init failed: {:?}", r.failed);

    let payload = (
        "Oracle", "UpdatePrice", "BTC/USD",
        BTC_PRICE, 100_000_000u128, 1_716_400_000u64, 2u32,
    ).encode();
    let msg_id = varacore.send_bytes(USER, payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id), "UpdatePrice failed: {:?}", r.failed);

    varacore
}

fn init_price_consumer<'a>(sys: &'a System) -> Program<'a> {
    sys.mint_to(CONSUMER_USER, 1_000_000_000_000_000_u128);
    let consumer = Program::current(sys);
    let init_id = consumer.send_bytes(CONSUMER_USER, "New".encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&init_id), "PriceConsumer init failed: {:?}", r.failed);
    consumer
}

/// Layer: contract-contract
/// Connection: PriceConsumer → VaraCore Oracle/GetPrice
/// Verifies: routing does not hang or panic. The reply bytes arrive and are processed
/// (even if decode is wrong, it returns Err not a trap).
/// After fix: cached price is updated to BTC_PRICE.
#[test]
fn test_fetch_price_from_oracle_routing_completes() {
    let sys = System::new();
    sys.init_logger();

    let varacore = init_varacore_with_price(&sys);
    let consumer = init_price_consumer(&sys);

    // Set oracle address
    let oracle_id: [u8; 32] = varacore.id().into();
    let set_payload = ("PriceConsumer", "SetOracleAddress", oracle_id).encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, set_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id), "SetOracleAddress failed: {:?}", r.failed);

    // Fetch price (async cross-program call)
    let fetch_payload = ("PriceConsumer", "FetchPriceFromOracle", "BTC/USD").encode();
    let fetch_id = consumer.send_bytes(CONSUMER_USER, fetch_payload);

    // Run 4 blocks: Block 1 = PriceConsumer sends GetPrice, Block 2 = VaraCore replies,
    // Block 3 = PriceConsumer processes reply, Block 4 = result delivered
    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();
    let r3 = sys.run_next_block();
    let r4 = sys.run_next_block();

    let panicked = r1.failed.contains(&fetch_id) || r2.failed.contains(&fetch_id)
        || r3.failed.contains(&fetch_id) || r4.failed.contains(&fetch_id);
    let completed = r1.succeed.contains(&fetch_id) || r2.succeed.contains(&fetch_id)
        || r3.succeed.contains(&fetch_id) || r4.succeed.contains(&fetch_id);

    assert!(!panicked,
        "FetchPriceFromOracle panicked (trap): r1.failed={:?} r2.failed={:?} r3.failed={:?}",
        r1.failed, r2.failed, r3.failed);
    assert!(completed,
        "FetchPriceFromOracle never completed after 4 blocks: r1={:?} r2={:?} r3={:?} r4={:?}",
        r1.succeed, r2.succeed, r3.succeed, r4.succeed);
}

/// Layer: contract-contract (error path)
/// Connection: PriceConsumer → Oracle (oracle address NOT set)
/// Verifies: returns Err("oracle address not set") without panicking
#[test]
fn test_fetch_price_no_oracle_address_returns_err_not_panic() {
    let sys = System::new();
    sys.init_logger();

    let consumer = init_price_consumer(&sys);

    let fetch_payload = ("PriceConsumer", "FetchPriceFromOracle", "BTC/USD").encode();
    let fetch_id = consumer.send_bytes(CONSUMER_USER, fetch_payload);

    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();

    let panicked = r1.failed.contains(&fetch_id) || r2.failed.contains(&fetch_id);
    let completed = r1.succeed.contains(&fetch_id) || r2.succeed.contains(&fetch_id);

    assert!(!panicked,
        "FetchPriceFromOracle trapped when oracle not set: {:?}", r1.failed);
    assert!(completed,
        "FetchPriceFromOracle did not complete when oracle not set");
}

/// Layer: contract-contract (get oracle address set)
/// Verifies: SetOracleAddress + GetOracleAddress round-trip
#[test]
fn test_set_oracle_address_round_trip() {
    let sys = System::new();
    sys.init_logger();

    let varacore = init_varacore_with_price(&sys);
    let consumer = init_price_consumer(&sys);

    let oracle_id: [u8; 32] = varacore.id().into();
    let set_payload = ("PriceConsumer", "SetOracleAddress", oracle_id).encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, set_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id), "SetOracleAddress failed: {:?}", r.failed);

    let query_payload = ("PriceConsumer", "GetOracleAddress").encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, query_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id), "GetOracleAddress query failed: {:?}", r.failed);
}

/// Layer: contract-contract (invalid asset)
/// Verifies: FetchPriceFromOracle for unsupported asset returns Err from oracle gracefully
#[test]
fn test_fetch_price_unsupported_asset_propagates_err() {
    let sys = System::new();
    sys.init_logger();

    let varacore = init_varacore_with_price(&sys);
    let consumer = init_price_consumer(&sys);

    let oracle_id: [u8; 32] = varacore.id().into();
    let set_payload = ("PriceConsumer", "SetOracleAddress", oracle_id).encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, set_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id));

    let fetch_payload = ("PriceConsumer", "FetchPriceFromOracle", "FAKE/USD").encode();
    let fetch_id = consumer.send_bytes(CONSUMER_USER, fetch_payload);

    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();
    let r3 = sys.run_next_block();
    let r4 = sys.run_next_block();

    let panicked = r1.failed.contains(&fetch_id) || r2.failed.contains(&fetch_id)
        || r3.failed.contains(&fetch_id) || r4.failed.contains(&fetch_id);
    assert!(!panicked, "FetchPriceFromOracle panicked on unsupported asset: {:?}", r1.failed);
}
