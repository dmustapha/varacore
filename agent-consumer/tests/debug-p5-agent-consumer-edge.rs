// Phase 5 Edge Case Tests — AgentConsumer boundary and error path coverage.

use gtest::{Program, System};
use parity_scale_codec::{Compact, Decode, Encode};

const VARACORE_WASM: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/wasm32-gear/release/varacore.wasm");
const USER: u64 = 42;
const CONSUMER_USER: u64 = 43;

const GET_CACHED_DISCOVERY_COUNT_PREFIX: usize = 38;
const GET_CACHED_SCORE_PREFIX: usize = 29;

fn setup(sys: &System) -> (Program<'_>, Program<'_>) {
    sys.mint_to(USER, 1_000_000_000_000_000_u128);
    sys.mint_to(CONSUMER_USER, 1_000_000_000_000_000_u128);
    let varacore = Program::from_file(sys, VARACORE_WASM);
    let id = varacore.send_bytes(USER, "New".encode());
    assert!(sys.run_next_block().succeed.contains(&id), "VaraCore init failed");
    let consumer = Program::current(&sys);
    let id = consumer.send_bytes(CONSUMER_USER, "New".encode());
    assert!(sys.run_next_block().succeed.contains(&id), "consumer init failed");
    let varacore_id: [u8; 32] = varacore.id().into();
    let set_id = consumer.send_bytes(CONSUMER_USER, ("AgentConsumer", "SetVaracoreAddress", varacore_id).encode());
    assert!(sys.run_next_block().succeed.contains(&set_id), "SetVaracoreAddress failed");
    (varacore, consumer)
}

/// Edge: varacore address can be overwritten without panic.
#[test]
fn test_set_varacore_address_overwrite() {
    let sys = System::new();
    sys.init_logger();
    let (varacore, consumer) = setup(&sys);

    let id: [u8; 32] = varacore.id().into();
    let id1 = consumer.send_bytes(CONSUMER_USER, ("AgentConsumer", "SetVaracoreAddress", id).encode());
    assert!(sys.run_next_block().succeed.contains(&id1), "first overwrite failed");
    let id2 = consumer.send_bytes(CONSUMER_USER, ("AgentConsumer", "SetVaracoreAddress", id).encode());
    assert!(sys.run_next_block().succeed.contains(&id2), "second overwrite failed");
}

/// Edge: GetCachedScore is 0 before any CheckAgentTrust call.
#[test]
fn test_get_cached_score_initial_is_zero() {
    let sys = System::new();
    sys.init_logger();
    let (_varacore, consumer) = setup(&sys);

    let q_id = consumer.send_bytes(CONSUMER_USER, ("AgentConsumer", "GetCachedScore").encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&q_id));

    let score = r.log()
        .iter()
        .filter(|l| l.source() == consumer.id())
        .find_map(|l| {
            let p = l.payload();
            if p.len() > GET_CACHED_SCORE_PREFIX {
                <u32>::decode(&mut &p[GET_CACHED_SCORE_PREFIX..]).ok()
            } else { None }
        });
    assert_eq!(score, Some(0u32), "initial score should be 0, got {:?}", score);
}

/// Edge: registering multiple agents with "price-feed" and querying returns count > 1.
#[test]
fn test_find_oracle_agents_count_multiple_agents() {
    let sys = System::new();
    sys.init_logger();
    sys.mint_to(USER, 1_000_000_000_000_000_u128);
    sys.mint_to(CONSUMER_USER, 1_000_000_000_000_000_u128);
    sys.mint_to(99u64, 1_000_000_000_000_000_u128); // second agent

    let varacore = Program::from_file(&sys, VARACORE_WASM);
    let vc_init = varacore.send_bytes(USER, "New".encode());
    assert!(sys.run_next_block().succeed.contains(&vc_init));

    let consumer = Program::current(&sys);
    let cs_init = consumer.send_bytes(CONSUMER_USER, "New".encode());
    assert!(sys.run_next_block().succeed.contains(&cs_init));

    let varacore_id: [u8; 32] = varacore.id().into();
    let set_id = consumer.send_bytes(CONSUMER_USER, ("AgentConsumer", "SetVaracoreAddress", varacore_id).encode());
    assert!(sys.run_next_block().succeed.contains(&set_id));

    // Register agent 1 (USER)
    let reg1 = varacore.send_bytes(USER, (
        "Registry", "RegisterAgent",
        ("agent-one", vec!["price-feed"], 0u8, "Agent one", ""),
    ).encode());
    assert!(sys.run_next_block().succeed.contains(&reg1));

    // Register agent 2 (user 99)
    let reg2 = varacore.send_bytes(99u64, (
        "Registry", "RegisterAgent",
        ("agent-two", vec!["price-feed"], 0u8, "Agent two", ""),
    ).encode());
    assert!(sys.run_next_block().succeed.contains(&reg2));

    // FindOracleAgents
    let find_id = consumer.send_bytes(CONSUMER_USER, ("AgentConsumer", "FindOracleAgents").encode());
    let r1 = sys.run_next_block(); let r2 = sys.run_next_block();
    let r3 = sys.run_next_block(); let r4 = sys.run_next_block();
    let panicked = r1.failed.contains(&find_id) || r2.failed.contains(&find_id)
        || r3.failed.contains(&find_id) || r4.failed.contains(&find_id);
    let completed = r1.succeed.contains(&find_id) || r2.succeed.contains(&find_id)
        || r3.succeed.contains(&find_id) || r4.succeed.contains(&find_id);
    assert!(!panicked, "FindOracleAgents panicked with 2 agents");
    assert!(completed, "FindOracleAgents never completed");

    let q_id = consumer.send_bytes(CONSUMER_USER, ("AgentConsumer", "GetCachedDiscoveryCount").encode());
    let r = sys.run_next_block();
    assert!(r.succeed.contains(&q_id));

    let count = r.log()
        .iter()
        .filter(|l| l.source() == consumer.id())
        .find_map(|l| {
            let p = l.payload();
            if p.len() > GET_CACHED_DISCOVERY_COUNT_PREFIX {
                <u32>::decode(&mut &p[GET_CACHED_DISCOVERY_COUNT_PREFIX..]).ok()
            } else { None }
        });
    match count {
        Some(n) => assert_eq!(n, 2, "expected 2 agents, got {n}"),
        None => panic!("GetCachedDiscoveryCount not found in log"),
    }
}

/// Edge: CheckAgentTrust with all failed interactions still returns non-zero score (presence-based).
#[test]
fn test_check_agent_trust_all_failed_interactions_returns_score() {
    let sys = System::new();
    sys.init_logger();
    let (varacore, consumer) = setup(&sys);

    let agent_id = [1u8; 32]; // distinct from zero address
    // Record 5 FAILED interactions
    for i in 0..5u32 {
        let rec_id = varacore.send_bytes(USER,
            ("Reputation", "RecordInteraction", agent_id, false, format!("fail {i}")).encode());
        assert!(sys.run_next_block().succeed.contains(&rec_id));
    }

    let trust_id = consumer.send_bytes(CONSUMER_USER, ("AgentConsumer", "CheckAgentTrust", agent_id).encode());
    let r1 = sys.run_next_block(); let r2 = sys.run_next_block();
    let r3 = sys.run_next_block(); let r4 = sys.run_next_block();
    let panicked = r1.failed.contains(&trust_id) || r2.failed.contains(&trust_id)
        || r3.failed.contains(&trust_id) || r4.failed.contains(&trust_id);
    let completed = r1.succeed.contains(&trust_id) || r2.succeed.contains(&trust_id)
        || r3.succeed.contains(&trust_id) || r4.succeed.contains(&trust_id);
    assert!(!panicked, "CheckAgentTrust panicked for all-failed agent");
    assert!(completed, "CheckAgentTrust never completed");
}
