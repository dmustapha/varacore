// File: agent-consumer/src/lib.rs
// BUG-002 FIXED: find_oracle_agents now skips 31-byte sails-rs prefix, uses Compact decode.
// BUG-003 FIXED: check_agent_trust now skips 22-byte prefix, decodes Result<ReputationData,String>.
// GAS FIX: reply_deposit raised from 2B to 50B (handle_reply gas trap fix).
#![no_std]
extern crate alloc;

use core::cell::RefCell;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use alloc::format;
use parity_scale_codec::{Encode, Decode, Compact};
use sails_rs::prelude::*;
use gstd::{msg, ActorId, prelude::*};

// ─────────────── Reply decode types ───────────────

/// Mirror of varacore::reputation::ReputationData for SCALE decode only.
#[derive(Decode)]
#[allow(dead_code)]
struct ReputationDataReply {
    total_interactions: u64,
    success_rate_bps: u16,
    days_active: u32,
    last_active_block: u32,
    score: u32,
}

// ─────────────── State ───────────────

pub struct AgentConsumerState {
    pub owner: ActorId,
    pub varacore_program_id: Option<ActorId>,
    pub last_score: u32,
    pub last_discovery_count: u32,
}

impl AgentConsumerState {
    fn new() -> Self {
        Self {
            owner: msg::source(),
            varacore_program_id: None,
            last_score: 0,
            last_discovery_count: 0,
        }
    }
}

// ─────────────── Service ───────────────

pub struct AgentConsumerService<'a> {
    state: &'a RefCell<AgentConsumerState>,
}

impl<'a> AgentConsumerService<'a> {
    pub fn new(state: &'a RefCell<AgentConsumerState>) -> Self {
        Self { state }
    }
}

#[service]
impl AgentConsumerService<'_> {
    /// Only the deployer (owner) can redirect the VaraCore target.
    #[export]
    pub fn set_varacore_address(&mut self, pid: ActorId) -> Result<(), String> {
        if msg::source() != self.state.borrow().owner {
            return Err("only the owner can set the varacore address".to_string());
        }
        self.state.borrow_mut().varacore_program_id = Some(pid);
        Ok(())
    }

    #[export]
    pub fn get_cached_score(&self) -> u32 {
        self.state.borrow().last_score
    }

    #[export]
    pub fn get_cached_discovery_count(&self) -> u32 {
        self.state.borrow().last_discovery_count
    }

    /// Cross-program call to ReputationService.ScoreAgent.
    #[export]
    pub async fn check_agent_trust(&mut self, agent_id: ActorId) -> Result<u32, String> {
        let pid = self.state.borrow().varacore_program_id
            .ok_or_else(|| "varacore address not set".to_string())?;

        // DEV-007: sails-rs routes = PascalCase of accessor fn names
        let payload: Vec<u8> = ("Reputation", "ScoreAgent", &agent_id).encode();

        // reply_deposit: 50B gas — must cover instrumented-code loading in handle_reply.
        let reply_bytes = msg::send_bytes_for_reply(pid, &payload, 0, 50_000_000_000)
            .map_err(|e| format!("send failed: {:?}", e))?
            .await
            .map_err(|e| format!("reply failed: {:?}", e))?;

        // BUG-003 FIX: sails-rs prefix = "Reputation"(11B) + "ScoreAgent"(11B) = 22 bytes.
        // Old code decoded from byte 0 AND used wrong type Result<u32,String>.
        const PREFIX: usize = 22; // "Reputation"(11) + "ScoreAgent"(11)
        if reply_bytes.len() < PREFIX {
            return Err("reply too short".to_string());
        }

        match <Result<ReputationDataReply, String>>::decode(&mut &reply_bytes[PREFIX..]) {
            Ok(Ok(data)) => {
                self.state.borrow_mut().last_score = data.score;
                Ok(data.score)
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("decode failed".to_string()),
        }
    }

    /// Cross-program call to AgentRegistryService.GetAgentsByCapability.
    #[export]
    pub async fn find_oracle_agents(&mut self) -> Result<u32, String> {
        let pid = self.state.borrow().varacore_program_id
            .ok_or_else(|| "varacore address not set".to_string())?;

        // DEV-007: sails-rs routes = PascalCase of accessor fn names
        let payload: Vec<u8> = ("Registry", "GetAgentsByCapability", "price-feed").encode();

        // reply_deposit: 50B gas — must cover instrumented-code loading in handle_reply.
        let reply_bytes = msg::send_bytes_for_reply(pid, &payload, 0, 50_000_000_000)
            .map_err(|e| format!("send failed: {:?}", e))?
            .await
            .map_err(|e| format!("reply failed: {:?}", e))?;

        // BUG-002 FIX: sails-rs prefix = "Registry"(9B) + "GetAgentsByCapability"(22B) = 31 bytes.
        // Old code used (reply_bytes.len() / 32) — wrong: counted bytes not agents.
        // Vec<AgentListing> in SCALE = Compact<u32> length prefix followed by encoded items.
        const PREFIX: usize = 31; // "Registry"(9) + "GetAgentsByCapability"(22)
        if reply_bytes.len() < PREFIX {
            return Err("reply too short".to_string());
        }

        let count = <Compact<u32>>::decode(&mut &reply_bytes[PREFIX..])
            .map(|c| c.0)
            .unwrap_or(0);

        self.state.borrow_mut().last_discovery_count = count;
        Ok(count)
    }
}

// ─────────────── Program ───────────────

pub struct AgentConsumerProgram {
    state: RefCell<AgentConsumerState>,
}

#[program]
impl AgentConsumerProgram {
    pub fn new() -> Self {
        Self {
            state: RefCell::new(AgentConsumerState::new()),
        }
    }

    pub fn agent_consumer(&self) -> AgentConsumerService {
        AgentConsumerService::new(&self.state)
    }
}
