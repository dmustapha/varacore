// Phase 5 Edge Case Tests — PriceConsumer boundary and error path coverage.

use gtest::{Program, System};
use parity_scale_codec::Encode;

const VARACORE_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32-gear/release/varacore.wasm");
const USER: u64 = 42;
const CONSUMER_USER: u64 = 43;

fn init_varacore(sys: &System) -> Program<'_> {
    sys.mint_to(USER, 1_000_000_000_000_000_u128);
    let varacore = Program::from_file(sys, VARACORE_WASM);
    let id = varacore.send_bytes(USER, "New".encode());
    assert!(sys.run_next_block().succeed.contains(&id));
    varacore
}

fn init_consumer(sys: &System) -> Program<'_> {
    sys.mint_to(CONSUMER_USER, 1_000_000_000_000_000_u128);
    let consumer = Program::current(&sys);
    let id = consumer.send_bytes(CONSUMER_USER, "New".encode());
    assert!(sys.run_next_block().succeed.contains(&id));
    consumer
}

/// Edge: oracle address can be overwritten with a new address without panic.
#[test]
fn test_set_oracle_address_overwrite_does_not_panic() {
    let sys = System::new();
    sys.init_logger();
    let varacore = init_varacore(&sys);
    let consumer = init_consumer(&sys);

    let oracle_id: [u8; 32] = varacore.id().into();

    // Set once
    let p1 = ("PriceConsumer", "SetOracleAddress", oracle_id).encode();
    let id1 = consumer.send_bytes(CONSUMER_USER, p1);
    assert!(sys.run_next_block().succeed.contains(&id1), "first set failed");

    // Set again (overwrite)
    let p2 = ("PriceConsumer", "SetOracleAddress", oracle_id).encode();
    let id2 = consumer.send_bytes(CONSUMER_USER, p2);
    assert!(sys.run_next_block().succeed.contains(&id2), "second set failed");
}

/// Edge: fetch for asset with zero confidence (confidence=0) should still succeed.
#[test]
fn test_fetch_price_zero_confidence_returns_ok() {
    let sys = System::new();
    sys.init_logger();
    let varacore = init_varacore(&sys);
    let consumer = init_consumer(&sys);

    // Seed price with confidence=0
    let update_payload = ("Oracle", "UpdatePrice", "ETH/USD", 3_500_000_000_000_000u128, 0u128, 1_716_400_000u64, 1u32).encode();
    let msg_id = varacore.send_bytes(USER, update_payload);
    assert!(sys.run_next_block().succeed.contains(&msg_id), "UpdatePrice failed");

    let oracle_id: [u8; 32] = varacore.id().into();
    let set_payload = ("PriceConsumer", "SetOracleAddress", oracle_id).encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, set_payload);
    assert!(sys.run_next_block().succeed.contains(&msg_id));

    let fetch_payload = ("PriceConsumer", "FetchPriceFromOracle", "ETH/USD").encode();
    let fetch_id = consumer.send_bytes(CONSUMER_USER, fetch_payload);

    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();
    let r3 = sys.run_next_block();
    let r4 = sys.run_next_block();

    let panicked = r1.failed.contains(&fetch_id) || r2.failed.contains(&fetch_id)
        || r3.failed.contains(&fetch_id) || r4.failed.contains(&fetch_id);
    let completed = r1.succeed.contains(&fetch_id) || r2.succeed.contains(&fetch_id)
        || r3.succeed.contains(&fetch_id) || r4.succeed.contains(&fetch_id);
    assert!(!panicked, "fetch with zero confidence panicked");
    assert!(completed, "fetch with zero confidence never completed");
}

/// Edge: multiple sequential fetches update the cache correctly each time.
#[test]
fn test_multiple_sequential_fetches_update_cache() {
    let sys = System::new();
    sys.init_logger();
    let varacore = init_varacore(&sys);
    let consumer = init_consumer(&sys);

    let oracle_id: [u8; 32] = varacore.id().into();
    let set_payload = ("PriceConsumer", "SetOracleAddress", oracle_id).encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, set_payload);
    assert!(sys.run_next_block().succeed.contains(&msg_id));

    // Seed BTC price
    let upd = ("Oracle", "UpdatePrice", "BTC/USD", 6_800_000_000_000_000u128, 100_000_000u128, 1_716_400_000u64, 2u32).encode();
    let msg_id = varacore.send_bytes(USER, upd);
    assert!(sys.run_next_block().succeed.contains(&msg_id));

    // First fetch
    let fetch_payload = ("PriceConsumer", "FetchPriceFromOracle", "BTC/USD").encode();
    let fetch_id = consumer.send_bytes(CONSUMER_USER, fetch_payload);
    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();
    let r3 = sys.run_next_block();
    let r4 = sys.run_next_block();
    let completed = r1.succeed.contains(&fetch_id) || r2.succeed.contains(&fetch_id)
        || r3.succeed.contains(&fetch_id) || r4.succeed.contains(&fetch_id);
    assert!(completed, "first fetch never completed");

    // Second fetch (same asset)
    let fetch_payload2 = ("PriceConsumer", "FetchPriceFromOracle", "BTC/USD").encode();
    let fetch_id2 = consumer.send_bytes(CONSUMER_USER, fetch_payload2);
    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();
    let r3 = sys.run_next_block();
    let r4 = sys.run_next_block();
    let panicked = r1.failed.contains(&fetch_id2) || r2.failed.contains(&fetch_id2)
        || r3.failed.contains(&fetch_id2) || r4.failed.contains(&fetch_id2);
    let completed = r1.succeed.contains(&fetch_id2) || r2.succeed.contains(&fetch_id2)
        || r3.succeed.contains(&fetch_id2) || r4.succeed.contains(&fetch_id2);
    assert!(!panicked, "second fetch panicked");
    assert!(completed, "second fetch never completed");
}

/// Edge: fetch for unsupported asset does not corrupt cached state from previous successful fetch.
#[test]
fn test_failed_fetch_does_not_corrupt_cached_price() {
    use parity_scale_codec::Decode;
    const GET_CACHED_PRICE_PREFIX: usize = 29;

    let sys = System::new();
    sys.init_logger();
    let varacore = init_varacore(&sys);
    let consumer = init_consumer(&sys);

    let oracle_id: [u8; 32] = varacore.id().into();
    let set_payload = ("PriceConsumer", "SetOracleAddress", oracle_id).encode();
    let set_id = consumer.send_bytes(CONSUMER_USER, set_payload);
    assert!(sys.run_next_block().succeed.contains(&set_id));

    // Seed BTC price
    let upd = ("Oracle", "UpdatePrice", "BTC/USD", 6_800_000_000_000_000u128, 100_000_000u128, 1_716_400_000u64, 2u32).encode();
    let upd_id = varacore.send_bytes(USER, upd);
    assert!(sys.run_next_block().succeed.contains(&upd_id));

    // Successful fetch of BTC
    let fetch_id = consumer.send_bytes(CONSUMER_USER, ("PriceConsumer", "FetchPriceFromOracle", "BTC/USD").encode());
    let (r1, r2, r3, r4) = (sys.run_next_block(), sys.run_next_block(), sys.run_next_block(), sys.run_next_block());
    assert!(r1.succeed.contains(&fetch_id) || r2.succeed.contains(&fetch_id)
        || r3.succeed.contains(&fetch_id) || r4.succeed.contains(&fetch_id));

    // Failed fetch of FAKE/USD (oracle returns Err) — should NOT corrupt cached price
    let fetch_id2 = consumer.send_bytes(CONSUMER_USER, ("PriceConsumer", "FetchPriceFromOracle", "FAKE/USD").encode());
    let (r1, r2, r3, r4) = (sys.run_next_block(), sys.run_next_block(), sys.run_next_block(), sys.run_next_block());
    let panicked = r1.failed.contains(&fetch_id2) || r2.failed.contains(&fetch_id2)
        || r3.failed.contains(&fetch_id2) || r4.failed.contains(&fetch_id2);
    assert!(!panicked, "FAKE/USD fetch panicked — should return Err gracefully");

    // Verify cached price is still BTC price
    let query_id = consumer.send_bytes(CONSUMER_USER, ("PriceConsumer", "GetCachedPrice").encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&query_id));

    let cached = r.log()
        .iter()
        .filter(|l| l.source() == consumer.id())
        .find_map(|l| {
            let p = l.payload();
            if p.len() > GET_CACHED_PRICE_PREFIX {
                <(String, u128)>::decode(&mut &p[GET_CACHED_PRICE_PREFIX..]).ok()
            } else {
                None
            }
        });

    if let Some((_asset, price)) = cached {
        assert_eq!(price, 6_800_000_000_000_000u128,
            "cached price was corrupted by failed fetch: got {price}");
    }
}
