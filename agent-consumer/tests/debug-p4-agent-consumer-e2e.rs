// Phase 4 E2E Tests — AgentConsumer end-to-end value verification.
// Verifies BUG-002 fix: discovery count matches actual registered agents.
// Verifies BUG-003 fix: trust score matches actual reputation data.

use gtest::{Program, System};
use parity_scale_codec::{Compact, Decode, Encode};

const VARACORE_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32-gear/release/varacore.wasm");
const USER: u64 = 42;
const CONSUMER_USER: u64 = 43;

// Sails-rs reply prefix lengths for AgentConsumer service.
// "AgentConsumer"(13) = 0x34 + 13B = 14B
// "GetCachedDiscoveryCount"(23) = 0x5c + 23B = 24B → prefix = 38
// "GetCachedScore"(14)          = 0x38 + 14B = 15B → prefix = 29
const GET_CACHED_DISCOVERY_COUNT_PREFIX: usize = 38;
const GET_CACHED_SCORE_PREFIX: usize = 29;

fn setup(sys: &System) -> (Program<'_>, Program<'_>) {
    sys.mint_to(USER, 1_000_000_000_000_000_u128);
    sys.mint_to(CONSUMER_USER, 1_000_000_000_000_000_u128);

    let varacore = Program::from_file(sys, VARACORE_WASM);
    let init_id = varacore.send_bytes(USER, "New".encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&init_id), "VaraCore init failed");

    let consumer = Program::current(&sys);
    let init_id = consumer.send_bytes(CONSUMER_USER, "New".encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&init_id), "AgentConsumer init failed");

    let varacore_id: [u8; 32] = varacore.id().into();
    let set_payload = ("AgentConsumer", "SetVaracoreAddress", varacore_id).encode();
    let msg_id = consumer.send_bytes(CONSUMER_USER, set_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&msg_id), "SetVaracoreAddress failed");

    (varacore, consumer)
}

/// Layer: E2E value — BUG-002 fix validation
/// Register 1 oracle agent in VaraCore with "price-feed" capability.
/// FindOracleAgents should cache count = 1 (not the byte-length nonsense from before).
#[test]
fn test_find_oracle_agents_correct_count_after_registration() {
    let sys = System::new();
    sys.init_logger();
    let (varacore, consumer) = setup(&sys);

    // USER registers themselves as a "price-feed" oracle in VaraCore.
    // AgentRegistration: hub_handle, capabilities, service_type(0=Oracle), description, endpoint_hint
    let reg_payload = (
        "Registry",
        "RegisterAgent",
        ("oracle-agent", vec!["price-feed"], 0u8, "E2E test oracle", ""),
    ).encode();
    let reg_id = varacore.send_bytes(USER, reg_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&reg_id), "RegisterAgent failed: {:?}", r.failed);

    // FindOracleAgents: cross-program call → Registry.GetAgentsByCapability("price-feed")
    let find_payload = ("AgentConsumer", "FindOracleAgents").encode();
    let find_id = consumer.send_bytes(CONSUMER_USER, find_payload);

    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();
    let r3 = sys.run_next_block();
    let r4 = sys.run_next_block();
    let panicked = r1.failed.contains(&find_id) || r2.failed.contains(&find_id)
        || r3.failed.contains(&find_id) || r4.failed.contains(&find_id);
    let completed = r1.succeed.contains(&find_id) || r2.succeed.contains(&find_id)
        || r3.succeed.contains(&find_id) || r4.succeed.contains(&find_id);
    assert!(!panicked, "FindOracleAgents panicked");
    assert!(completed, "FindOracleAgents never completed");

    // GetCachedDiscoveryCount → must be 1
    let query_payload = ("AgentConsumer", "GetCachedDiscoveryCount").encode();
    let query_id = consumer.send_bytes(CONSUMER_USER, query_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&query_id));

    let count = r.log()
        .iter()
        .filter(|l| l.source() == consumer.id())
        .find_map(|l| {
            let p = l.payload();
            if p.len() > GET_CACHED_DISCOVERY_COUNT_PREFIX {
                <u32>::decode(&mut &p[GET_CACHED_DISCOVERY_COUNT_PREFIX..]).ok()
            } else {
                None
            }
        });

    match count {
        Some(n) => assert_eq!(n, 1, "expected count=1, got {n}"),
        None => panic!("GetCachedDiscoveryCount reply not found in log; log={}", r.log().len()),
    }
}

/// Layer: E2E value — BUG-002 zero-agent path
/// With no registered "price-feed" agents, FindOracleAgents caches count = 0.
#[test]
fn test_find_oracle_agents_zero_when_none_registered() {
    let sys = System::new();
    sys.init_logger();
    let (_varacore, consumer) = setup(&sys);

    let find_payload = ("AgentConsumer", "FindOracleAgents").encode();
    let find_id = consumer.send_bytes(CONSUMER_USER, find_payload);

    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();
    let r3 = sys.run_next_block();
    let r4 = sys.run_next_block();
    let completed = r1.succeed.contains(&find_id) || r2.succeed.contains(&find_id)
        || r3.succeed.contains(&find_id) || r4.succeed.contains(&find_id);
    assert!(completed, "FindOracleAgents(no agents) never completed");

    let query_payload = ("AgentConsumer", "GetCachedDiscoveryCount").encode();
    let query_id = consumer.send_bytes(CONSUMER_USER, query_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&query_id));

    let count = r.log()
        .iter()
        .filter(|l| l.source() == consumer.id())
        .find_map(|l| {
            let p = l.payload();
            if p.len() > GET_CACHED_DISCOVERY_COUNT_PREFIX {
                <u32>::decode(&mut &p[GET_CACHED_DISCOVERY_COUNT_PREFIX..]).ok()
            } else {
                None
            }
        });

    match count {
        Some(n) => assert_eq!(n, 0, "expected 0 agents, got {n}"),
        None => panic!("GetCachedDiscoveryCount reply not found in log"),
    }
}

/// Layer: E2E value — BUG-003 fix validation
/// Record interactions for [0u8; 32] agent, then CheckAgentTrust returns score > 0.
#[test]
fn test_check_agent_trust_returns_nonzero_score_after_interactions() {
    let sys = System::new();
    sys.init_logger();
    let (varacore, consumer) = setup(&sys);

    // Record 3 successful interactions for zero-address agent
    let agent_id = [0u8; 32];
    for i in 0..3u32 {
        let context = format!("interaction {i}");
        let record_payload = ("Reputation", "RecordInteraction", agent_id, true, context).encode();
        let record_id = varacore.send_bytes(USER, record_payload);
        let r = sys.run_next_block();
        assert!(r.succeed.contains(&record_id), "RecordInteraction {i} failed: {:?}", r.failed);
    }

    // CheckAgentTrust(zero_agent): cross-program → Reputation.ScoreAgent
    let trust_payload = ("AgentConsumer", "CheckAgentTrust", agent_id).encode();
    let trust_id = consumer.send_bytes(CONSUMER_USER, trust_payload);

    let r1 = sys.run_next_block();
    let r2 = sys.run_next_block();
    let r3 = sys.run_next_block();
    let r4 = sys.run_next_block();
    let panicked = r1.failed.contains(&trust_id) || r2.failed.contains(&trust_id)
        || r3.failed.contains(&trust_id) || r4.failed.contains(&trust_id);
    let completed = r1.succeed.contains(&trust_id) || r2.succeed.contains(&trust_id)
        || r3.succeed.contains(&trust_id) || r4.succeed.contains(&trust_id);
    assert!(!panicked, "CheckAgentTrust panicked");
    assert!(completed, "CheckAgentTrust never completed");

    // GetCachedScore → must be > 0
    let query_payload = ("AgentConsumer", "GetCachedScore").encode();
    let query_id = consumer.send_bytes(CONSUMER_USER, query_payload);
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&query_id));

    let score = r.log()
        .iter()
        .filter(|l| l.source() == consumer.id())
        .find_map(|l| {
            let p = l.payload();
            if p.len() > GET_CACHED_SCORE_PREFIX {
                <u32>::decode(&mut &p[GET_CACHED_SCORE_PREFIX..]).ok()
            } else {
                None
            }
        });

    match score {
        Some(s) => assert!(s > 0, "expected score > 0 after 3 successful interactions, got {s}"),
        None => panic!("GetCachedScore reply not found in log; log={}", r.log().len()),
    }
}
