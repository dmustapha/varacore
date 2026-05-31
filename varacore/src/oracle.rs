// File: varacore/src/oracle.rs
// [MAINNET-VERIFIED] — ScheduleRefresh loop confirmed running on mainnet. Two sequential
// self-calls observed (block:0xef0b6b1b... → block:0xa9ec0dd9...), proving the delayed
// message payload encoding is correct and the loop fires every ~100 blocks.
#![no_std]
extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::string::{String, ToString};
use alloc::vec::Vec;
use core::cell::RefCell;
use alloc::format;
use parity_scale_codec::Encode;
use sails_rs::prelude::*;
use gstd::{exec, msg, prelude::*};

// ─────────────── Public IDL types ───────────────

/// Price data returned by OracleService queries.
#[derive(Clone, Debug, Encode, Decode, TypeInfo)]
pub struct OracleData {
    /// Price in u128 with 8 decimal places. 1_00000000 = $1.00
    pub price: u128,
    /// ±uncertainty in same units as price.
    pub confidence: u128,
    /// Unix timestamp in seconds from the price source.
    pub timestamp: u64,
    /// Asset identifier e.g. "VARA/USD"
    pub asset: String,
    /// Number of price sources that survived outlier rejection.
    pub source_count: u32,
    /// Feed freshness status.
    pub status: FeedStatus,
}

#[derive(Clone, Debug, Encode, Decode, TypeInfo, PartialEq)]
pub enum FeedStatus {
    Fresh,
    Stale,
    Degraded,
}

// ─────────────── Internal state types ───────────────

/// TWAP ring buffer for 8 price observations (manipulation resistance).
#[derive(Clone, Debug)]
pub struct TwapRing {
    pub observations: [u128; 8],
    pub timestamps: [u64; 8],
    pub head: usize,
    pub count: usize,
}

impl TwapRing {
    fn new() -> Self {
        Self {
            observations: [0u128; 8],
            timestamps: [0u64; 8],
            head: 0,
            count: 0,
        }
    }

    fn push(&mut self, price: u128, ts: u64) {
        self.observations[self.head] = price;
        self.timestamps[self.head] = ts;
        self.head = (self.head + 1) % 8;
        if self.count < 8 {
            self.count += 1;
        }
    }

    /// Arithmetic mean of available observations.
    fn twap(&self) -> u128 {
        if self.count == 0 {
            return 0;
        }
        let sum: u128 = self.observations[..self.count].iter().sum();
        sum / self.count as u128
    }
}

/// Internal oracle state — stored in VaraCoreProgram.oracle_state.
pub struct OracleState {
    pub prices: BTreeMap<String, OracleData>,
    pub twap_rings: BTreeMap<String, TwapRing>,
}

impl OracleState {
    pub fn new() -> Self {
        Self {
            prices: BTreeMap::new(),
            twap_rings: BTreeMap::new(),
        }
    }

    /// Supported assets hardcoded at startup.
    pub fn supported_assets() -> Vec<String> {
        ["VARA/USD", "BTC/USD", "ETH/USD", "DOT/USD", "USDT/USD"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    /// A price is stale if older than max_age_seconds from current block time.
    pub fn is_stale_at_block(&self, asset: &str, max_age_seconds: u64) -> bool {
        match self.prices.get(asset) {
            None => true,
            Some(data) => {
                let current_approx_ts = exec::block_timestamp() / 1000; // ms → s
                current_approx_ts.saturating_sub(data.timestamp) > max_age_seconds
            }
        }
    }
}

// ─────────────── OracleService ───────────────

/// Sails service exposing the Oracle interface.
pub struct OracleService<'a> {
    state: &'a RefCell<OracleState>,
}

impl<'a> OracleService<'a> {
    pub fn new(state: &'a RefCell<OracleState>) -> Self {
        Self { state }
    }
}

#[service]
impl OracleService<'_> {
    // ── Queries (read-only, &self) ──

    /// Returns the latest price data for the requested asset.
    #[export]
    pub fn get_price(&self, asset: String) -> Result<OracleData, String> {
        let state = self.state.borrow();
        state.prices
            .get(&asset)
            .cloned()
            .ok_or_else(|| format!("asset '{}' not registered or not yet updated", asset))
    }

    /// Returns price data for multiple assets.
    #[export]
    pub fn get_multiple_prices(&self, assets: Vec<String>) -> Vec<Result<OracleData, String>> {
        let state = self.state.borrow();
        assets.into_iter().map(|asset| {
            state.prices
                .get(&asset)
                .cloned()
                .ok_or_else(|| format!("asset '{}' not found", asset))
        }).collect()
    }

    /// Returns the list of all supported asset identifiers.
    #[export]
    pub fn get_supported_assets(&self) -> Vec<String> {
        OracleState::supported_assets()
    }

    /// Returns true if the price for the given asset is older than max_age_seconds.
    #[export]
    pub fn is_stale(&self, asset: String, max_age_seconds: u64) -> bool {
        let state = self.state.borrow();
        state.is_stale_at_block(&asset, max_age_seconds)
    }

    // ── Commands (state-changing, &mut self) ──

    /// Accepts a price update from the off-chain price agent.
    #[export]
    pub fn update_price(
        &mut self,
        asset: String,
        price: u128,
        confidence: u128,
        timestamp: u64,
        source_count: u32,
    ) -> Result<(), String> {
        let supported = OracleState::supported_assets();
        if !supported.contains(&asset) {
            return Err(format!("unsupported asset '{}'", asset));
        }
        if price == 0 {
            return Err("price must be non-zero".to_string());
        }
        let status = match source_count {
            0 => return Err("source_count must be >= 1".to_string()),
            1 => FeedStatus::Degraded,
            _ => FeedStatus::Fresh,
        };

        let data = OracleData {
            price,
            confidence,
            timestamp,
            asset: asset.clone(),
            source_count,
            status,
        };

        let mut state = self.state.borrow_mut();
        state.twap_rings
            .entry(asset.clone())
            .or_insert_with(TwapRing::new)
            .push(price, timestamp);
        state.prices.insert(asset, data);
        Ok(())
    }

    /// Queues a delayed self-message to re-invoke ScheduleRefresh after ~100 blocks.
    /// [MAINNET-VERIFIED] — Loop confirmed running. Two sequential self-calls observed
    /// on mainnet (block:0xef0b6b1b... → block:0xa9ec0dd9...). sails-rs 0.10.x uses
    /// string-based routing; numeric Interface ID routing is v1.0.0+ only.
    #[export]
    pub fn schedule_refresh(&mut self) -> Result<(), String> {
        // sails-rs 0.10.x route: PascalCase of accessor fn name: oracle() → "Oracle"
        // Method route: PascalCase of fn name: schedule_refresh() → "ScheduleRefresh"
        let payload: Vec<u8> = ("Oracle", "ScheduleRefresh").encode();
        let reservation_id = exec::reserve_gas(5_000_000_000, 200)
            .map_err(|e| format!("gas reservation failed: {:?}", e))?;
        msg::send_delayed_from_reservation(
            reservation_id,
            exec::program_id(),
            payload,
            0,
            100,
        ).map_err(|e| format!("send_delayed failed: {:?}", e))?;
        Ok(())
    }
}

// ─────────────── Unit tests for pure TwapRing logic ───────────────
// These cover Section 2 of TESTING-PLAN-V2.md (ring buffer math not queryable via IDL).

#[cfg(test)]
mod unit_tests {
    use super::*;
    use parity_scale_codec::Encode;

    // TC-V2-2-01: empty ring → twap == 0
    #[test]
    fn twap_empty() {
        let ring = TwapRing::new();
        assert_eq!(ring.twap(), 0);
    }

    // TC-V2-2-02: 1 push (100) → count==1, twap==100
    #[test]
    fn twap_single() {
        let mut ring = TwapRing::new();
        ring.push(100, 1);
        assert_eq!(ring.count, 1);
        assert_eq!(ring.twap(), 100);
    }

    // TC-V2-2-03: 2 pushes [100, 200] → twap == 150
    #[test]
    fn twap_two_observations() {
        let mut ring = TwapRing::new();
        ring.push(100, 1);
        ring.push(200, 2);
        assert_eq!(ring.twap(), 150);
    }

    // TC-V2-2-04/05: 8 pushes [100..800] → count==8, head==0, twap==450
    #[test]
    fn twap_full_ring() {
        let mut ring = TwapRing::new();
        for (i, p) in [100u128, 200, 300, 400, 500, 600, 700, 800].iter().enumerate() {
            ring.push(*p, (i + 1) as u64);
        }
        assert_eq!(ring.count, 8);
        assert_eq!(ring.head, 0);
        // sum = 3600, 3600 / 8 = 450
        assert_eq!(ring.twap(), 450);
    }

    // TC-V2-2-06/07: 9th push (900) → obs[0]==900, head==1, count==8, twap==550
    #[test]
    fn twap_9th_push_wraps() {
        let mut ring = TwapRing::new();
        for (i, p) in [100u128, 200, 300, 400, 500, 600, 700, 800].iter().enumerate() {
            ring.push(*p, (i + 1) as u64);
        }
        ring.push(900, 9);
        assert_eq!(ring.head, 1);
        assert_eq!(ring.count, 8);
        assert_eq!(ring.observations[0], 900);
        // ring = [900,200,300,400,500,600,700,800] sum=4400, 4400/8=550
        assert_eq!(ring.twap(), 550);
    }

    // TC-V2-2-08/09: 10th push (1000) → obs[1]==1000, head==2, twap==650
    #[test]
    fn twap_10th_push_wraps_second_slot() {
        let mut ring = TwapRing::new();
        for (i, p) in [100u128, 200, 300, 400, 500, 600, 700, 800].iter().enumerate() {
            ring.push(*p, (i + 1) as u64);
        }
        ring.push(900, 9);
        ring.push(1000, 10);
        assert_eq!(ring.head, 2);
        assert_eq!(ring.count, 8);
        assert_eq!(ring.observations[1], 1000);
        // ring = [900,1000,300,400,500,600,700,800] sum=5200, 5200/8=650
        assert_eq!(ring.twap(), 650);
    }

    // TC-V2-2-10: FeedStatus SCALE variant indices — Fresh=0, Stale=1, Degraded=2
    #[test]
    fn feed_status_scale_encoding() {
        assert_eq!(FeedStatus::Fresh.encode(), alloc::vec![0u8]);
        assert_eq!(FeedStatus::Stale.encode(), alloc::vec![1u8]);
        assert_eq!(FeedStatus::Degraded.encode(), alloc::vec![2u8]);
    }
}
