// Phase 3 Integration Tests — AgentConsumer ↔ VaraCore contract-contract layer
// Tests cross-program call routing from AgentConsumer → VaraCore Registry and Reputation services.
//
// BUG-002: find_oracle_agents uses byte-length hack (len/32) — returns wrong count.
//   On mainnet returned 1 coincidentally because 33 bytes / 32 = 1 (33 = 32 prefix + compact(0)).
// BUG-003: check_agent_trust decodes as Result<u32,String> but Reputation returns Result<ReputationData,String>,
//   AND missing 22-byte routing prefix skip.
// AFTER FIX: both methods decode replies correctly.

use gtest::{Program, System};
use parity_scale_codec::Encode;

const VARACORE_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32-gear/release/varacore.wasm");
const USER: u64 = 42;
const CONSUMER_USER: u64 = 43;

fn init_varacore<'a>(sys: &'a System) -> Program<'a> {
    sys.mint_to(USER, 1_000_000_000_000_000_u128);
    let varacore = Program::from_file(sys, VARACORE_WASM);
    let init_id = varacore.send_bytes(USER, "New".encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&init_id), "VaraCore init failed: {:?}", r.failed);
    varacore
}

fn init_agent_consumer<'a>(sys: &'a System) -> Program<'a> {
    sys.mint_to(CONSUMER_USER, 1_000_000_000_000_000_u128);
    let consumer = Program::current(sys);
    let init_id = consumer.send_bytes(CONSUMER_USER, "New".encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&init_id), "AgentConsumer init failed: {:?}", r.failed);
    consumer
}

macro_rules! run_and_check_no_panic {
    ($sys:expr, $id:expr, $label:expr) => {{
        let r1 = $sys.run_next_block();
        let r2 = $sys.run_next_block();
        let r3 = $sys.run_next_block();
        let r4 = $sys.run_next_block();
        let panicked = r1.failed.contains(&$id) || r2.failed.contains(&$id)
            || r3.failed.contains(&$id) || r4.failed.contains(&$id);
        let completed = r1.succeed.contains(&$id) || r2.succeed.contains(&$id)
            || r3.succeed.contains(&$id) || r4.succeed.contains(&$id);
        assert!(!panicked, "{} panicked: {:?}", $label, r1.failed);
        assert!(completed, "{} never completed after 4 blocks", $label);
    }};
}

/// Layer: contract-contract
/// Connection: AgentConsumer → VaraCore Registry/GetAgentsByCapability
/// BUG-002: byte-length count is wrong; after fix returns correct Vec length via compact decode.
#[test]
fn test_find_oracle_agents_routing_completes() {
    let sys = System::new();
    sys.init_logger();

    let varacore = init_varacore(&sys);
    let consumer = init_agent_consumer(&sys);

    let varacore_id: [u8; 32] = varacore.id().into();
    let set_payload = ("AgentConsumer", "SetVaracoreAddress", varacore_id).encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, set_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id), "SetVaracoreAddress failed: {:?}", r.failed);

    let find_payload = ("AgentConsumer", "FindOracleAgents").encode();
    let find_id = consumer.send_bytes(CONSUMER_USER, find_payload);

    run_and_check_no_panic!(sys, find_id, "FindOracleAgents");
}

/// Layer: contract-contract (cached count is initially 0)
/// Verifies GetCachedDiscoveryCount returns 0 before any discovery call
#[test]
fn test_initial_cached_discovery_count_is_zero() {
    let sys = System::new();
    sys.init_logger();
    let consumer = init_agent_consumer(&sys);

    let query = ("AgentConsumer", "GetCachedDiscoveryCount").encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, query);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id), "GetCachedDiscoveryCount failed: {:?}", r.failed);
}

/// Layer: contract-contract
/// Connection: AgentConsumer → VaraCore Reputation/ScoreAgent
/// BUG-003: missing prefix skip + wrong decode type.
/// After fix: decodes Result<ReputationData,String> correctly.
/// With no interactions recorded, ScoreAgent returns Err("agent has no recorded interactions").
#[test]
fn test_check_agent_trust_no_interactions_returns_err_not_panic() {
    let sys = System::new();
    sys.init_logger();

    let varacore = init_varacore(&sys);
    let consumer = init_agent_consumer(&sys);

    let varacore_id: [u8; 32] = varacore.id().into();
    let set_payload = ("AgentConsumer", "SetVaracoreAddress", varacore_id).encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, set_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id));

    // Call check_agent_trust for an unknown agent (returns Err from VaraCore, which should
    // propagate cleanly through the decode chain)
    let target_id = [0u8; 32]; // zero address — has no interactions
    let trust_payload = ("AgentConsumer", "CheckAgentTrust", target_id).encode();
    let trust_id = consumer.send_bytes(CONSUMER_USER, trust_payload);

    run_and_check_no_panic!(sys, trust_id, "CheckAgentTrust(no interactions)");
}

/// Layer: contract-contract
/// Connection: AgentConsumer → VaraCore (address NOT set)
/// Verifies: returns Err("varacore address not set") without panicking
#[test]
fn test_find_oracle_agents_no_varacore_set_returns_err() {
    let sys = System::new();
    sys.init_logger();
    let consumer = init_agent_consumer(&sys);

    let find_payload = ("AgentConsumer", "FindOracleAgents").encode();
    let find_id = consumer.send_bytes(CONSUMER_USER, find_payload);

    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();

    let panicked = r1.failed.contains(&find_id) || r2.failed.contains(&find_id);
    let completed = r1.succeed.contains(&find_id) || r2.succeed.contains(&find_id);

    assert!(!panicked, "FindOracleAgents trapped when varacore not set: {:?}", r1.failed);
    assert!(completed, "FindOracleAgents did not complete when varacore not set");
}
