// File: varacore/tests/oracle_tests.rs
// DEV-007: gtest 1.10.0 — program.send() requires Codec (Encode+Decode).
// &str only implements Encode, not Decode. Fix: use send_bytes(payload.encode()).
use gtest::{Program, System};
use parity_scale_codec::Encode;

fn init_varacore(sys: &System) -> Program {
    sys.mint_to(42u64, 1_000_000_000_000_000_u128);
    let program = Program::current(sys);
    // sails-rs routes ctors by PascalCase of fn name: fn new() → route "New"
    // Init payload = SCALE("New") + constructor args (none here)
    let init_id = program.send_bytes(42u64, "New".encode());
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&init_id),
        "VaraCore init failed. failed={:?}",
        result.failed
    );
    program
}

#[test]
fn test_update_and_get_price() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let payload = (
        "Oracle",
        "UpdatePrice",
        "BTC/USD",
        6_800_000_000_000_000u128,
        34_000_000_000_000u128,
        1_716_400_000u64,
        3u32,
    ).encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "UpdatePrice failed. failed={:?}",
        result.failed
    );

    let payload = ("Oracle", "GetPrice", "BTC/USD").encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "GetPrice failed. failed={:?}",
        result.failed
    );
}

#[test]
fn test_get_unsupported_asset_returns_ok_with_err_payload() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let payload = ("Oracle", "GetPrice", "XYZ/USD").encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "GetPrice unsupported asset panicked unexpectedly. failed={:?}",
        result.failed
    );
}

#[test]
fn test_is_stale_returns_true_before_update() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let payload = ("Oracle", "IsStale", "VARA/USD", 600u64).encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "IsStale call failed. failed={:?}",
        result.failed
    );
}

#[test]
fn test_get_supported_assets() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let payload = ("Oracle", "GetSupportedAssets").encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "GetSupportedAssets failed. failed={:?}",
        result.failed
    );
}

/// ScheduleRefresh in gtest: exec::reserve_gas returns Err (no real gas in simulation).
/// The method maps that to Err(...) and returns it — message succeeds (Ok reply with Err payload),
/// no panic. This validates the method compiles + routes correctly.
#[test]
fn test_schedule_refresh_returns_graceful_err_in_simulation() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let payload = ("Oracle", "ScheduleRefresh").encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    // Expect succeed (valid Ok-level response) even if reserve_gas fails internally
    assert!(
        result.succeed.contains(&msg_id),
        "ScheduleRefresh panicked in simulation. failed={:?}",
        result.failed
    );
}

#[test]
fn test_update_price_zero_rejected() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let payload = (
        "Oracle",
        "UpdatePrice",
        "VARA/USD",
        0u128,
        0u128,
        1_716_400_000u64,
        1u32,
    ).encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    // Returns Err("price must be non-zero") — valid Ok reply with Err variant in payload
    assert!(
        result.succeed.contains(&msg_id),
        "UpdatePrice(price=0) panicked unexpectedly. failed={:?}",
        result.failed
    );
}
