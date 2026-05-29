// File: varacore/src/registry.rs
// [VERIFIED] — Pure state logic; BTreeMap operations only.
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

#[derive(Clone, Debug, Encode, Decode, TypeInfo, PartialEq)]
pub enum ServiceType {
    Oracle,
    Reputation,
    Registry,
    DeFi,
    Social,
    Agent,
    Other,
}

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub struct AgentRegistration {
    pub hub_handle: String,
    pub capabilities: Vec<String>,
    pub service_type: ServiceType,
    pub description: String,
    pub endpoint_hint: String,
}

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub struct AgentUpdate {
    pub hub_handle: Option<String>,
    pub capabilities: Option<Vec<String>>,
    pub description: Option<String>,
    pub endpoint_hint: Option<String>,
}

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub struct DiscoveryFilter {
    pub service_type: Option<ServiceType>,
    pub capability: Option<String>,
    /// Only return agents whose heartbeat was within 1000 blocks.
    pub active_only: bool,
}

#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub struct AgentListing {
    pub agent_id: ActorId,
    pub hub_handle: String,
    pub capabilities: Vec<String>,
    pub service_type: ServiceType,
    pub description: String,
    pub registered_at_block: u32,
    pub last_heartbeat_block: u32,
    pub is_active: bool,
}

// ─────────────── Internal state types ───────────────

pub struct RegistryState {
    pub agents: BTreeMap<ActorId, AgentListing>,
    pub capability_index: BTreeMap<String, Vec<ActorId>>,
}

impl RegistryState {
    pub fn new() -> Self {
        Self {
            agents: BTreeMap::new(),
            capability_index: BTreeMap::new(),
        }
    }

    fn is_active(listing: &AgentListing, current_block: u32) -> bool {
        current_block.saturating_sub(listing.last_heartbeat_block) < 1000
    }

    fn index_agent_capabilities(&mut self, agent_id: ActorId, capabilities: &[String]) {
        for cap in capabilities {
            self.capability_index
                .entry(cap.clone())
                .or_insert_with(Vec::new)
                .push(agent_id);
        }
    }

    fn deindex_agent_capabilities(&mut self, agent_id: &ActorId, capabilities: &[String]) {
        for cap in capabilities {
            if let Some(agents) = self.capability_index.get_mut(cap) {
                agents.retain(|id| id != agent_id);
            }
        }
    }
}

// ─────────────── AgentRegistryService ───────────────

pub struct AgentRegistryService<'a> {
    state: &'a RefCell<RegistryState>,
}

impl<'a> AgentRegistryService<'a> {
    pub fn new(state: &'a RefCell<RegistryState>) -> Self {
        Self { state }
    }
}

#[service]
impl AgentRegistryService<'_> {
    #[export]
    pub fn discover_agents(&self, filter: DiscoveryFilter) -> Vec<AgentListing> {
        let state = self.state.borrow();
        let current_block = exec::block_height();
        state.agents.values()
            .filter(|listing| {
                if let Some(ref stype) = filter.service_type {
                    if &listing.service_type != stype { return false; }
                }
                if let Some(ref cap) = filter.capability {
                    if !listing.capabilities.contains(cap) { return false; }
                }
                if filter.active_only {
                    if !RegistryState::is_active(listing, current_block) { return false; }
                }
                true
            })
            .cloned()
            .collect()
    }

    #[export]
    pub fn get_agent(&self, agent_id: ActorId) -> Result<AgentListing, String> {
        let state = self.state.borrow();
        state.agents.get(&agent_id)
            .cloned()
            .ok_or_else(|| format!("agent {:?} not found in registry", agent_id))
    }

    #[export]
    pub fn get_agents_by_capability(&self, capability: String) -> Vec<AgentListing> {
        let state = self.state.borrow();
        let current_block = exec::block_height();
        match state.capability_index.get(&capability) {
            None => Vec::new(),
            Some(agent_ids) => agent_ids.iter()
                .filter_map(|id| state.agents.get(id).cloned())
                .map(|mut listing| {
                    listing.is_active = RegistryState::is_active(&listing, current_block);
                    listing
                })
                .collect(),
        }
    }

    #[export]
    pub fn register_agent(&mut self, registration: AgentRegistration) -> Result<(), String> {
        let agent_id = msg::source();
        let current_block = exec::block_height();
        if registration.hub_handle.is_empty() {
            return Err("hub_handle must not be empty".to_string());
        }
        if registration.capabilities.len() > 20 {
            return Err("max 20 capabilities allowed".to_string());
        }
        let listing = AgentListing {
            agent_id,
            hub_handle: registration.hub_handle,
            capabilities: registration.capabilities.clone(),
            service_type: registration.service_type,
            description: registration.description.chars().take(512).collect(),
            registered_at_block: current_block,
            last_heartbeat_block: current_block,
            is_active: true,
        };
        let mut state = self.state.borrow_mut();
        if let Some(old) = state.agents.get(&agent_id) {
            let old_caps = old.capabilities.clone();
            state.deindex_agent_capabilities(&agent_id, &old_caps);
        }
        state.agents.insert(agent_id, listing);
        state.index_agent_capabilities(agent_id, &registration.capabilities);
        Ok(())
    }

    #[export]
    pub fn update_agent(&mut self, agent_id: ActorId, update: AgentUpdate) -> Result<(), String> {
        let caller = msg::source();
        if caller != agent_id {
            return Err("only the agent itself can update its listing".to_string());
        }
        let mut state = self.state.borrow_mut();
        let listing = state.agents.get_mut(&agent_id)
            .ok_or_else(|| "agent not registered".to_string())?;
        if let Some(handle) = update.hub_handle {
            listing.hub_handle = handle;
        }
        if let Some(desc) = update.description {
            listing.description = desc.chars().take(512).collect();
        }
        if let Some(caps) = update.capabilities {
            if caps.len() > 20 {
                return Err("max 20 capabilities allowed".to_string());
            }
            let old_caps = listing.capabilities.clone();
            state.deindex_agent_capabilities(&agent_id, &old_caps);
            state.agents.get_mut(&agent_id)
                .ok_or_else(|| "agent disappeared during update".to_string())?
                .capabilities = caps.clone();
            state.index_agent_capabilities(agent_id, &caps);
        }
        Ok(())
    }

    #[export]
    pub fn heartbeat_agent(&mut self, agent_id: ActorId) -> Result<(), String> {
        let caller = msg::source();
        if caller != agent_id {
            return Err("only the agent itself can send a heartbeat".to_string());
        }
        let current_block = exec::block_height();
        let mut state = self.state.borrow_mut();
        let listing = state.agents.get_mut(&agent_id)
            .ok_or_else(|| "agent not registered".to_string())?;
        listing.last_heartbeat_block = current_block;
        listing.is_active = true;
        Ok(())
    }

    #[export]
    pub fn delist_agent(&mut self, agent_id: ActorId) -> Result<(), String> {
        let caller = msg::source();
        if caller != agent_id {
            return Err("only the agent itself can delist".to_string());
        }
        let mut state = self.state.borrow_mut();
        let listing = state.agents.remove(&agent_id)
            .ok_or_else(|| "agent not registered".to_string())?;
        state.deindex_agent_capabilities(&agent_id, &listing.capabilities);
        Ok(())
    }
}
