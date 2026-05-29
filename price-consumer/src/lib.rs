// File: price-consumer/src/lib.rs
// BUG-001 FIXED: reply_deposit raised from 2B to 50B (handle_reply gas trap fix).
// BUG-001 FIXED: decode now skips 16-byte sails-rs prefix and decodes Result<OracleData,String>.
#![no_std]
extern crate alloc;

use core::cell::RefCell;
use alloc::string::{String, ToString};
use alloc::format;
use alloc::vec::Vec;
use parity_scale_codec::{Encode, Decode};
use sails_rs::prelude::*;
use gstd::{msg, ActorId, prelude::*};

// ─────────────── Reply decode types ───────────────

/// Mirror of varacore::oracle::FeedStatus for SCALE decode only.
#[derive(Decode)]
#[allow(dead_code)]
enum FeedStatus { Fresh, Stale, Degraded }

/// Mirror of varacore::oracle::OracleData for SCALE decode only.
#[derive(Decode)]
#[allow(dead_code)]
struct OracleDataReply {
    price: u128,
    confidence: u128,
    timestamp: u64,
    asset: String,
    source_count: u32,
    status: FeedStatus,
}

// ─────────────── State ───────────────

pub struct PriceConsumerState {
    pub owner: ActorId,
    pub oracle_program_id: Option<ActorId>,
    pub last_price: u128,
    pub last_asset: String,
}

impl PriceConsumerState {
    fn new() -> Self {
        Self {
            owner: msg::source(),
            oracle_program_id: None,
            last_price: 0,
            last_asset: String::new(),
        }
    }
}

// ─────────────── Service ───────────────

pub struct PriceConsumerService<'a> {
    state: &'a RefCell<PriceConsumerState>,
}

impl<'a> PriceConsumerService<'a> {
    pub fn new(state: &'a RefCell<PriceConsumerState>) -> Self {
        Self { state }
    }
}

#[service]
impl PriceConsumerService<'_> {
    #[export]
    pub fn get_oracle_address(&self) -> Option<ActorId> {
        self.state.borrow().oracle_program_id
    }

    #[export]
    pub fn get_cached_price(&self) -> (String, u128) {
        let s = self.state.borrow();
        (s.last_asset.clone(), s.last_price)
    }

    /// Sets the VaraCore program ID. Only the deployer (owner) can call this.
    #[export]
    pub fn set_oracle_address(&mut self, oracle_pid: ActorId) -> Result<(), String> {
        if msg::source() != self.state.borrow().owner {
            return Err("only the owner can set the oracle address".to_string());
        }
        self.state.borrow_mut().oracle_program_id = Some(oracle_pid);
        Ok(())
    }

    /// Fetches latest price for asset from VaraCore OracleService.
    #[export]
    pub async fn fetch_price_from_oracle(&mut self, asset: String) -> Result<u128, String> {
        let oracle_pid = self.state.borrow().oracle_program_id
            .ok_or_else(|| "oracle address not set".to_string())?;

        // DEV-007: sails-rs route = PascalCase of accessor fn: oracle() → "Oracle"
        let payload: Vec<u8> = ("Oracle", "GetPrice", &asset).encode();

        // reply_deposit: 50B gas — must cover instrumented-code loading in handle_reply.
        // 2B was too small (caused "Not enough gas to obtain instrumented code" trap).
        let reply_bytes = msg::send_bytes_for_reply(
            oracle_pid,
            &payload,
            0,
            50_000_000_000,
        )
        .map_err(|e| format!("send failed: {:?}", e))?
        .await
        .map_err(|e| format!("reply failed: {:?}", e))?;

        // BUG-001 FIX: sails-rs prepends "Oracle"(7B) + "GetPrice"(9B) = 16-byte routing prefix.
        // Old code decoded from byte 0 — always failed.
        const PREFIX: usize = 16; // "Oracle"(7) + "GetPrice"(9)
        if reply_bytes.len() < PREFIX {
            return Err("reply too short".to_string());
        }

        match <Result<OracleDataReply, String>>::decode(&mut &reply_bytes[PREFIX..]) {
            Ok(Ok(data)) => {
                self.state.borrow_mut().last_price = data.price;
                self.state.borrow_mut().last_asset = asset;
                Ok(data.price)
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("failed to decode reply".to_string()),
        }
    }
}

// ─────────────── Program ───────────────

pub struct PriceConsumerProgram {
    state: RefCell<PriceConsumerState>,
}

#[program]
impl PriceConsumerProgram {
    pub fn new() -> Self {
        Self {
            state: RefCell::new(PriceConsumerState::new()),
        }
    }

    pub fn price_consumer(&self) -> PriceConsumerService {
        PriceConsumerService::new(&self.state)
    }
}
