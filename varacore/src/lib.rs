// File: varacore/src/lib.rs
#![no_std]
extern crate alloc;

use sails_rs::prelude::*;
use gstd::prelude::*;
use core::cell::RefCell;

mod oracle;
mod reputation;
mod registry;

pub use oracle::{OracleService, OracleState};
pub use reputation::{ReputationService, ReputationState};
pub use registry::{AgentRegistryService, RegistryState};

/// The main VaraCore program. One deploy. Three services.
pub struct VaraCoreProgram {
    oracle_state: RefCell<OracleState>,
    rep_state: RefCell<ReputationState>,
    reg_state: RefCell<RegistryState>,
}

#[program]
impl VaraCoreProgram {
    /// Called once at program upload — initializes all three service states.
    pub fn new() -> Self {
        Self {
            oracle_state: RefCell::new(OracleState::new()),
            rep_state: RefCell::new(ReputationState::new()),
            reg_state: RefCell::new(RegistryState::new()),
        }
    }

    /// Returns an OracleService bound to the oracle state.
    pub fn oracle(&self) -> OracleService {
        OracleService::new(&self.oracle_state)
    }

    /// Returns a ReputationService bound to the reputation state.
    pub fn reputation(&self) -> ReputationService {
        ReputationService::new(&self.rep_state)
    }

    /// Returns an AgentRegistryService bound to the registry state.
    pub fn registry(&self) -> AgentRegistryService {
        AgentRegistryService::new(&self.reg_state)
    }
}
