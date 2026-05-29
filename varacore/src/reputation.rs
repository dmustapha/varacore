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
