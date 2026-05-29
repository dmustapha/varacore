// Phase 4 E2E Tests — PriceConsumer end-to-end value verification.
// Verifies BUG-001 fix: cached price is actually updated with the oracle's returned value.
// These go beyond Phase 3 (no-panic) to assert correct decoded state.

use gtest::{Program, System};
use parity_scale_codec::{Decode, Encode};

const VARACORE_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32-gear/release/varacore.wasm");
const USER: u64 = 42;
const CONSUMER_USER: u64 = 43;
const BTC_PRICE: u128 = 6_800_000_000_000_000;

// Sails-rs reply prefix lengths for PriceConsumer service.
// Format: compact(len) + name bytes for each segment.
// "PriceConsumer"(13) = 0x34 + 13B = 14B
// "GetCachedPrice"(14) = 0x38 + 14B = 15B
const GET_CACHED_PRICE_PREFIX: usize = 29; // 14 + 15

fn setup(sys: &System) -> (Program<'_>, Program<'_>) {
    sys.mint_to(USER, 1_000_000_000_000_000_u128);
    sys.mint_to(CONSUMER_USER, 1_000_000_000_000_000_u128);

    let varacore = Program::from_file(sys, VARACORE_WASM);
    let init_id = varacore.send_bytes(USER, "New".encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&init_id), "VaraCore init failed");

    let update_payload = ("Oracle", "UpdatePrice", "BTC/USD", BTC_PRICE, 100_000_000u128, 1_716_400_000u64, 2u32).encode();
    let msg_id = varacore.send_bytes(USER, update_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id), "UpdatePrice failed");

    let consumer = Program::current(&sys);
    let init_id = consumer.send_bytes(CONSUMER_USER, "New".encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&init_id), "PriceConsumer init failed");

    let set_payload = ("PriceConsumer", "SetOracleAddress", Into::<[u8; 32]>::into(varacore.id())).encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, set_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id), "SetOracleAddress failed");

    (varacore, consumer)
}

/// Layer: E2E value verification
/// After FetchPriceFromOracle succeeds, GetCachedPrice returns the oracle's actual BTC price.
/// Validates BUG-001 fix: correct decode of Result<OracleData,String> with 16-byte prefix skip.
#[test]
fn test_fetch_price_updates_cached_price() {
    let sys = System::new();
    sys.init_logger();
    let (_varacore, consumer) = setup(&sys);

    // Trigger the cross-program fetch
    let fetch_payload = ("PriceConsumer", "FetchPriceFromOracle", "BTC/USD").encode();
    let fetch_id = consumer.send_bytes(CONSUMER_USER, fetch_payload);
    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();
    let r3 = sys.run_next_block();
    let r4 = sys.run_next_block();
    let completed = r1.succeed.contains(&fetch_id) || r2.succeed.contains(&fetch_id)
        || r3.succeed.contains(&fetch_id) || r4.succeed.contains(&fetch_id);
    assert!(completed, "FetchPriceFromOracle did not complete");

    // Query cached price
    let query_payload = ("PriceConsumer", "GetCachedPrice").encode();
    let query_id = consumer.send_bytes(CONSUMER_USER, query_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&query_id), "GetCachedPrice query failed");

    // Decode the reply from log (sails-rs prefix = 29 bytes, then (String, u128))
    let price = r.log()
        .iter()
        .filter(|l| l.source() == consumer.id())
        .find_map(|l| {
            let payload = l.payload();
            if payload.len() > GET_CACHED_PRICE_PREFIX {
                <(String, u128)>::decode(&mut &payload[GET_CACHED_PRICE_PREFIX..]).ok()
            } else {
                None
            }
        });

    match price {
        Some((asset, p)) => {
            assert_eq!(p, BTC_PRICE, "cached price mismatch: got {p}, want {BTC_PRICE}");
            assert_eq!(asset, "BTC/USD", "cached asset mismatch");
        }
        None => panic!("GetCachedPrice reply not found in log; r.log()={:?}", r.log().len()),
    }
}

/// Layer: E2E default state
/// Before any fetch, GetCachedPrice returns ("", 0).
#[test]
fn test_get_cached_price_initial_is_zero() {
    let sys = System::new();
    sys.init_logger();
    sys.mint_to(CONSUMER_USER, 1_000_000_000_000_000_u128);
    let consumer = Program::current(&sys);
    let init_id = consumer.send_bytes(CONSUMER_USER, "New".encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&init_id));

    let query_payload = ("PriceConsumer", "GetCachedPrice").encode();
    let query_id = consumer.send_bytes(CONSUMER_USER, query_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&query_id), "GetCachedPrice query failed");

    let price = r.log()
        .iter()
        .filter(|l| l.source() == consumer.id())
        .find_map(|l| {
            let payload = l.payload();
            if payload.len() > GET_CACHED_PRICE_PREFIX {
                <(String, u128)>::decode(&mut &payload[GET_CACHED_PRICE_PREFIX..]).ok()
            } else {
                None
            }
        });

    match price {
        Some((_asset, p)) => assert_eq!(p, 0u128, "initial price should be 0"),
        None => panic!("GetCachedPrice reply not found in log"),
    }
}
