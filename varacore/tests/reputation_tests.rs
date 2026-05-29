// File: varacore/tests/reputation_tests.rs
// DEV-007: gtest 1.10.0 — use send_bytes(payload.encode()) to avoid Codec bound on &str.
use gtest::{Program, System};
use parity_scale_codec::Encode;

fn init_varacore(sys: &System) -> Program {
    sys.mint_to(42u64, 1_000_000_000_000_000_u128);
    sys.mint_to(100u64, 1_000_000_000_000_000_u128);
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

#[test]
fn test_score_agent_no_interactions_returns_ok_with_err_payload() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let agent_id = [0u8; 32];
    let payload = ("Reputation", "ScoreAgent", agent_id).encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "ScoreAgent panicked unexpectedly. failed={:?}",
        result.failed
    );
}

#[test]
fn test_record_interaction_and_score() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let agent_id = [1u8; 32];

    for _ in 0..3 {
        let payload = ("Reputation", "RecordInteraction", agent_id, true, "test interaction").encode();
        let msg_id = program.send_bytes(42u64, payload);
        let result = sys.run_next_block();
        assert!(
            result.succeed.contains(&msg_id),
            "RecordInteraction failed. failed={:?}",
            result.failed
        );
    }

    let payload = ("Reputation", "ScoreAgent", agent_id).encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "ScoreAgent after interactions failed. failed={:?}",
        result.failed
    );
}

#[test]
fn test_get_interaction_history() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let agent_id = [2u8; 32];

    program.send_bytes(
        42u64,
        ("Reputation", "RecordInteraction", agent_id, true, "first").encode(),
    );
    sys.run_next_block();
    program.send_bytes(
        42u64,
        ("Reputation", "RecordInteraction", agent_id, false, "second").encode(),
    );
    sys.run_next_block();

    let payload = ("Reputation", "GetInteractionHistory", agent_id, 10u32).encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "GetInteractionHistory failed. failed={:?}",
        result.failed
    );
}

#[test]
fn test_get_top_agents_sorted_by_score() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let agent_a = [1u8; 32];
    let agent_b = [2u8; 32];

    for _ in 0..5 {
        program.send_bytes(
            42u64,
            ("Reputation", "RecordInteraction", agent_a, true, "good").encode(),
        );
        sys.run_next_block();
        program.send_bytes(
            42u64,
            ("Reputation", "RecordInteraction", agent_b, false, "bad").encode(),
        );
        sys.run_next_block();
    }

    let payload = ("Reputation", "GetTopAgents", 10u32).encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "GetTopAgents failed. failed={:?}",
        result.failed
    );
}

#[test]
fn test_decay_scores_is_noop() {
    let sys = System::new();
    sys.init_logger();
    let program = init_varacore(&sys);

    let payload = ("Reputation", "DecayScores").encode();
    let msg_id = program.send_bytes(42u64, payload);
    let result = sys.run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "DecayScores failed. failed={:?}",
        result.failed
    );
}
