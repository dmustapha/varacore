// File: varacore/tests/registry_tests.rs
// DEV-007: gtest 1.10.0 — use send_bytes(payload.encode()) to avoid Codec bound on &str.
use gtest::{Program, System};
use parity_scale_codec::Encode;

fn init_varacore(sys: &System) -> Program {
    sys.mint_to(42u64, 1_000_000_000_000_000_u128);
    sys.mint_to(100u64, 1_000_000_000_000_000_u128);
    sys.mint_to(101u64, 1_000_000_000_000_000_u128);
    let program = Program::current(sys);
    let init_id = program.send_bytes(42u64, "New".encode());
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&init_id),
        "VaraCore init failed. failed={:?}",
        result.failed
    );
    program
}

/// Encode a RegisterAgent payload for an Oracle-type agent.
/// AgentRegistration fields in declaration order:
///   hub_handle: String, capabilities: Vec<String>, service_type: ServiceType,
///   description: String, endpoint_hint: String
/// ServiceType::Oracle = variant index 0u8
fn register_oracle_agent_payload(user: u64) -> Vec<u8> {
    let _ = user; // user is passed to send, not in payload
    (
        "Registry",
        "RegisterAgent",
        "varacore-dev",                       // hub_handle
        vec!["price-feed", "vara-usd"],        // capabilities
        0u8,                                   // ServiceType::Oracle (first variant)
        "Multi-asset oracle for Vara",         // description
        "https://example.com",                 // endpoint_hint
    ).encode()
}

fn agent_actor_id(user: u64) -> [u8; 32] {
    // gtest maps user u64 to ActorId where the first 8 bytes are the u64 in little-endian
    // and the remaining 24 bytes are zero.
    let mut id = [0u8; 32];
    id[..8].copy_from_slice(&user.to_le_bytes());
    id
}

#[test]
fn test_register_and_get_agent() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    // Register agent as user 100
    let msg_id = program.send_bytes(100u64, register_oracle_agent_payload(100));
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "RegisterAgent failed. failed={:?}",
        result.failed
    );

    // GetAgent — ActorId for user 100
    let agent_id = agent_actor_id(100);
    let payload = ("Registry", "GetAgent", agent_id).encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "GetAgent failed. failed={:?}",
        result.failed
    );
}

#[test]
fn test_get_agents_by_capability() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    program.send_bytes(100u64, register_oracle_agent_payload(100));
    sys.run_next_block();

    let payload = ("Registry", "GetAgentsByCapability", "price-feed").encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "GetAgentsByCapability failed. failed={:?}",
        result.failed
    );
}

#[test]
fn test_discover_agents_no_filter() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    program.send_bytes(100u64, register_oracle_agent_payload(100));
    sys.run_next_block();

    // DiscoveryFilter { service_type: None, capability: None, active_only: false }
    let payload = (
        "Registry",
        "DiscoverAgents",
        Option::<u8>::None, // service_type: None
        Option::<&str>::None, // capability: None
        false, // active_only
    ).encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "DiscoverAgents failed. failed={:?}",
        result.failed
    );
}

#[test]
fn test_heartbeat_updates_agent() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    program.send_bytes(100u64, register_oracle_agent_payload(100));
    sys.run_next_block();

    let agent_id = agent_actor_id(100);
    let payload = ("Registry", "HeartbeatAgent", agent_id).encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "HeartbeatAgent failed. failed={:?}",
        result.failed
    );
}

#[test]
fn test_delist_removes_agent() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    program.send_bytes(100u64, register_oracle_agent_payload(100));
    sys.run_next_block();

    let agent_id = agent_actor_id(100);
    let payload = ("Registry", "DelistAgent", agent_id).encode();
    // Must be sent by the same user (100) who registered
    let msg_id = program.send_bytes(100u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "DelistAgent failed. failed={:?}",
        result.failed
    );
}

#[test]
fn test_delist_by_other_returns_err_payload() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    program.send_bytes(100u64, register_oracle_agent_payload(100));
    sys.run_next_block();

    let agent_id = agent_actor_id(100);
    let payload = ("Registry", "DelistAgent", agent_id).encode();
    // Send as user 42 — not the owner, should get Err reply payload (not panic)
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "DelistAgent by stranger panicked. failed={:?}",
        result.failed
    );
    // Handler returns Err("only the agent itself can delist")
}
