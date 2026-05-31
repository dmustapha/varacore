// File: varacore/src/reputation.rs
// [VERIFIED] — Pure state logic; no external API dependencies.
#![no_std]
extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::cell::RefCell;
use alloc::format;
use parity_scale_codec::Encode;
use sails_rs::prelude::*;
use gstd::{exec, msg, ActorId, prelude::*};

// ─────────────── Public IDL types ───────────────

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub struct ReputationData {
    pub total_interactions: u64,
    /// Basis points: 10000 = 100% success rate.
    pub success_rate_bps: u16,
    pub days_active: u32,
    pub last_active_block: u32,
    /// Composite score 0-1000.
    pub score: u32,
}

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub struct InteractionRecord {
    pub caller: ActorId,
    pub success: bool,
    pub block_number: u32,
    /// Short context description. Truncated to 256 chars.
    pub context: String,
}

// ─────────────── Internal state types ───────────────

#[derive(Clone, Debug)]
pub struct AgentReputation {
    pub total_interactions: u64,
    pub successful_interactions: u64,
    pub first_active_block: u32,
    pub last_active_block: u32,
}

impl AgentReputation {
    fn new(block: u32) -> Self {
        Self {
            total_interactions: 0,
            successful_interactions: 0,
            first_active_block: block,
            last_active_block: block,
        }
    }

    fn success_rate_bps(&self) -> u16 {
        if self.total_interactions == 0 {
            return 0;
        }
        ((self.successful_interactions * 10_000) / self.total_interactions) as u16
    }

    fn days_active(&self, current_block: u32) -> u32 {
        let blocks_elapsed = current_block.saturating_sub(self.first_active_block);
        // ~20 blocks per minute, ~28800 blocks per day
        blocks_elapsed / 28_800
    }
}

/// Internal reputation state.
pub struct ReputationState {
    pub agents: BTreeMap<ActorId, AgentReputation>,
    pub histories: BTreeMap<ActorId, Vec<InteractionRecord>>,
}

impl ReputationState {
    pub fn new() -> Self {
        Self {
            agents: BTreeMap::new(),
            histories: BTreeMap::new(),
        }
    }
}

// ─────────────── Scoring helpers ───────────────

fn floor_log2(x: u64) -> u32 {
    if x == 0 { return 0; }
    63 - x.leading_zeros()
}

fn compute_score(rep: &AgentReputation, current_block: u32) -> u32 {
    let success_bps = rep.success_rate_bps() as u64;
    let c1 = (success_bps * 40) / 10_000;
    let c2 = floor_log2(rep.total_interactions) as u64 * 5;
    let days = rep.days_active(current_block) as u64;
    let c3 = floor_log2(days + 1) as u64 * 7;
    let c4: u64 = if rep.total_interactions > 0 { 10 } else { 0 };
    let raw = (c1 + c2 + c3 + c4).min(100);
    (raw * 10) as u32
}

// ─────────────── ReputationService ───────────────

pub struct ReputationService<'a> {
    state: &'a RefCell<ReputationState>,
}

impl<'a> ReputationService<'a> {
    pub fn new(state: &'a RefCell<ReputationState>) -> Self {
        Self { state }
    }
}

#[service]
impl ReputationService<'_> {
    #[export]
    pub fn score_agent(&self, agent_id: ActorId) -> Result<ReputationData, String> {
        let state = self.state.borrow();
        let current_block = exec::block_height();
        let rep = state.agents.get(&agent_id)
            .ok_or_else(|| "agent has no recorded interactions".to_string())?;
        Ok(ReputationData {
            total_interactions: rep.total_interactions,
            success_rate_bps: rep.success_rate_bps(),
            days_active: rep.days_active(current_block),
            last_active_block: rep.last_active_block,
            score: compute_score(rep, current_block),
        })
    }

    #[export]
    pub fn get_top_agents(&self, limit: u32) -> Vec<(ActorId, ReputationData)> {
        let state = self.state.borrow();
        let current_block = exec::block_height();
        let cap = (limit as usize).min(100);
        let mut scored: Vec<(ActorId, ReputationData)> = state.agents.iter()
            .map(|(&agent_id, rep)| {
                let data = ReputationData {
                    total_interactions: rep.total_interactions,
                    success_rate_bps: rep.success_rate_bps(),
                    days_active: rep.days_active(current_block),
                    last_active_block: rep.last_active_block,
                    score: compute_score(rep, current_block),
                };
                (agent_id, data)
            })
            .collect();
        scored.sort_by(|a, b| b.1.score.cmp(&a.1.score));
        scored.truncate(cap);
        scored
    }

    #[export]
    pub fn get_interaction_history(
        &self,
        agent_id: ActorId,
        limit: u32,
    ) -> Vec<InteractionRecord> {
        let state = self.state.borrow();
        let cap = (limit as usize).min(50);
        match state.histories.get(&agent_id) {
            None => Vec::new(),
            Some(history) => {
                let start = history.len().saturating_sub(cap);
                history[start..].to_vec()
            }
        }
    }

    #[export]
    pub fn record_interaction(
        &mut self,
        agent_id: ActorId,
        success: bool,
        context: String,
    ) -> Result<(), String> {
        let caller = msg::source();
        let block = exec::block_height();
        let safe_context: String = context.chars().take(256).collect();
        let mut state = self.state.borrow_mut();
        let rep = state.agents
            .entry(agent_id)
            .or_insert_with(|| AgentReputation::new(block));
        rep.total_interactions += 1;
        if success {
            rep.successful_interactions += 1;
        }
        rep.last_active_block = block;
        let history = state.histories.entry(agent_id).or_insert_with(Vec::new);
        if history.len() >= 50 {
            history.remove(0);
        }
        history.push(InteractionRecord {
            caller,
            success,
            block_number: block,
            context: safe_context,
        });
        Ok(())
    }

    #[export]
    pub fn decay_scores(&mut self) -> Result<(), String> {
        // No-op: scores are computed fresh from stored data. IDL-retained for forward compat.
        Ok(())
    }
}

// ─────────────── Unit tests for pure scoring logic ───────────────
// Covers Sections 4–6 of TESTING-PLAN-V2.md (score math, days_active, c3 longevity).

#[cfg(test)]
mod unit_tests {
    use super::*;

    fn make_rep(total: u64, successful: u64, first_block: u32) -> AgentReputation {
        AgentReputation {
            total_interactions: total,
            successful_interactions: successful,
            first_active_block: first_block,
            last_active_block: first_block,
        }
    }

    // floor_log2 boundary values
    #[test]
    fn floor_log2_boundaries() {
        assert_eq!(floor_log2(0), 0);
        assert_eq!(floor_log2(1), 0);
        assert_eq!(floor_log2(2), 1);
        assert_eq!(floor_log2(3), 1);
        assert_eq!(floor_log2(4), 2);
        assert_eq!(floor_log2(7), 2);
        assert_eq!(floor_log2(8), 3);
        assert_eq!(floor_log2(16), 4);
        assert_eq!(floor_log2(32), 5);
        assert_eq!(floor_log2(64), 6);
        assert_eq!(floor_log2(128), 7);
        assert_eq!(floor_log2(256), 8);
    }

    // days_active formula: blocks_elapsed / 28800
    #[test]
    fn days_active_formula() {
        let rep = make_rep(0, 0, 0);
        assert_eq!(rep.days_active(0), 0);
        assert_eq!(rep.days_active(28_799), 0); // one block short
        assert_eq!(rep.days_active(28_800), 1); // exactly 1 day
        assert_eq!(rep.days_active(86_400), 3); // 3 days
        assert_eq!(rep.days_active(201_600), 7); // 7 days
    }

    // zero interactions → score 0
    #[test]
    fn score_zero_interactions() {
        let rep = make_rep(0, 0, 0);
        assert_eq!(compute_score(&rep, 0), 0);
    }

    // c2 (interaction count) score table: n interactions, all success, day 0
    // c1=40, c2=floor_log2(n)*5, c3=0, c4=10 → raw=50+c2, score=(50+c2)*10
    #[test]
    fn score_c2_table() {
        let cases: &[(u64, u32)] = &[
            (1,   500),
            (2,   550),
            (4,   600),
            (8,   650),
            (16,  700),
            (32,  750),
            (64,  800),
            (128, 850),
            (256, 900),
        ];
        for &(n, expected) in cases {
            let rep = make_rep(n, n, 0);
            assert_eq!(compute_score(&rep, 0), expected, "n_interactions={}", n);
        }
    }

    // TC-V2-4-10: c3 longevity — 1 interaction (100% success), 1 day elapsed
    // first_active_block=0, current_block=28800 → days=1
    // c1=40, c2=0, c3=floor_log2(2)*7=7, c4=10 → raw=57, score=570
    #[test]
    fn score_c3_one_day() {
        let rep = make_rep(1, 1, 0);
        assert_eq!(compute_score(&rep, 28_800), 570);
    }

    // TC-V2-4-11: c3 at 3 days
    // days=3, floor_log2(4)=2, c3=14 → c1=40, c2=0, c3=14, c4=10 → raw=64, score=640
    #[test]
    fn score_c3_three_days() {
        let rep = make_rep(1, 1, 0);
        assert_eq!(compute_score(&rep, 86_400), 640);
    }

    // TC-V2-4-12: c3 at 7 days
    // days=7, floor_log2(8)=3, c3=21 → c1=40, c2=0, c3=21, c4=10 → raw=71, score=710
    #[test]
    fn score_c3_seven_days() {
        let rep = make_rep(1, 1, 0);
        assert_eq!(compute_score(&rep, 201_600), 710);
    }
}
