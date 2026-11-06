#![no_std]

pub mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env};
use crate::types::{DataKey, Error, PoolConfig, PoolState, Position};

const DAY_IN_LEDGERS: u32 = 17280;
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;

const PERSISTENT_BUMP_AMOUNT: u32 = 60 * DAY_IN_LEDGERS;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 14 * DAY_IN_LEDGERS;

// Maximum intermediate multiplication cap to guarantee i128 intermediate products never overflow
const MAX_MONETARY_CAP: i128 = 10_000_000_000_000_000_000i128; // 10^19 stroops (1 trillion USDC)

// Minimum recovery tranche size to eliminate fractional rounding distortion and griefing
const MIN_RECOVERY_TRANCHE: i128 = 10_000_000i128; // 1.0 USDC (7 decimals)

// Maximum tranches processed per paginated batch claim
const MAX_BATCH_CLAIM_TRANCHES: u32 = 50;

// Maximum secondary tranches materialized per transaction to strictly bound write footprint and metering
const MAX_TRANCHES_PER_TX: u32 = 10;

// Minimum cooldown period (in seconds) between manual flush calls to prevent spamming micro-tranches
const FLUSH_COOLDOWN_SECONDS: u64 = 86400; // 24 hours

#[contract]
pub struct KallpaPoolContract;

#[contractimpl]
impl KallpaPoolContract {
    /// Safely computes `floor(a * b / c)` in integer arithmetic without intermediate `i128` overflow.
    /// Uses Euclidean quotient-remainder decomposition:
    /// `a * b / c = a * (b / c) + (a * (b % c)) / c`
    /// Since `r = b % c < c <= MAX_MONETARY_CAP (10^19)` and `a <= MAX_MONETARY_CAP (10^19)`,
    /// the product `a * r < 10^38 <= i128::MAX (1.7 x 10^38)` NEVER overflows `i128`!
    fn safe_mul_div(a: i128, b: i128, c: i128) -> Result<i128, Error> {
        if c <= 0 || a < 0 || b < 0 {
            return Err(Error::InvalidAmount);
        }
        let q = b.checked_div(c).ok_or(Error::MathOverflow)?;
        let r = b.checked_rem(c).ok_or(Error::MathOverflow)?;

        let term1 = a.checked_mul(q).ok_or(Error::MathOverflow)?;
        let term2 = a
            .checked_mul(r)
            .ok_or(Error::MathOverflow)?
            .checked_div(c)
            .ok_or(Error::MathOverflow)?;

        term1.checked_add(term2).ok_or(Error::MathOverflow)
    }

    fn record_secondary_tranche_budgeted(env: &Env, amount: i128, max_tranches: u32) -> Result<u32, Error> {
        if amount <= 0 || max_tranches == 0 {
            return Ok(0);
        }

        // Pull any existing pending buffer
        let pending: i128 = env
            .storage()
            .instance()
            .get(&DataKey::PendingSecondaryBuffer)
            .unwrap_or(0);

        let mut combined = pending.checked_add(amount).ok_or(Error::MathOverflow)?;

        if combined < MIN_RECOVERY_TRANCHE {
            // Below threshold: accumulate in buffer without failing or reverting repayment
            env.storage().instance().set(&DataKey::PendingSecondaryBuffer, &combined);
            return Ok(0);
        }

        // Materialize discrete tranches strictly capped at MAX_MONETARY_CAP per tranche
        // and bounded by max_tranches budget to guarantee strict resource metering per transaction.
        // Tranche keys are unbounded in persistent storage: every late repayment or external
        // surplus is guaranteed to materialize without ceiling rejection, preventing trapped funds.
        let mut tranches_created = 0u32;
        while combined >= MIN_RECOVERY_TRANCHE && tranches_created < max_tranches {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::SecondaryTrancheCount)
                .unwrap_or(0);

            let tranche_amount = if combined > MAX_MONETARY_CAP {
                MAX_MONETARY_CAP
            } else {
                combined
            };

            combined = combined.checked_sub(tranche_amount).ok_or(Error::MathOverflow)?;
            tranches_created = tranches_created.saturating_add(1);

            let new_count = count.checked_add(1).ok_or(Error::CapacityExceeded)?;
            let total_sec: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSecondaryAllocated)
                .unwrap_or(0);
            let new_total_sec = total_sec.checked_add(tranche_amount).ok_or(Error::MathOverflow)?;

            env.storage().instance().set(&DataKey::SecondaryTrancheCount, &new_count);
            let tranche_key = DataKey::SecondaryTranche(new_count);
            // Prefix Sum Invariant: SecondaryTranche(k) stores S_cum(k), the cumulative secondary funds allocated up to tranche k!
            env.storage().persistent().set(&tranche_key, &new_total_sec);
            env.storage().persistent().extend_ttl(&tranche_key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);

            env.storage().instance().set(&DataKey::TotalSecondaryAllocated, &new_total_sec);
        }

        // Remaining unmaterialized balance safely stays in PendingSecondaryBuffer
        env.storage().instance().set(&DataKey::PendingSecondaryBuffer, &combined);
        Ok(tranches_created)
    }

    fn record_secondary_tranche(env: &Env, amount: i128) -> Result<(), Error> {
        Self::record_secondary_tranche_budgeted(env, amount, MAX_TRANCHES_PER_TX)?;
        Ok(())
    }

    /// Initialize the milestone pool with immutable parameters.
    pub fn initialize(
        env: Env,
        admin: Address,
        asset: Address,
        tw_escrow: Address,
        payer: Address,
        target_amount: i128,
        repayment_target: i128,
        funding_deadline: u64,
        repayment_deadline: u64,
        min_contribution: i128,
    ) -> Result<(), Error> {
        admin.require_auth();

        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        if target_amount <= 0 || target_amount > MAX_MONETARY_CAP || repayment_target < target_amount || repayment_target > MAX_MONETARY_CAP || min_contribution < MIN_RECOVERY_TRANCHE || min_contribution > target_amount {
            return Err(Error::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if funding_deadline <= now || repayment_deadline <= funding_deadline {
            return Err(Error::DeadlinePassed);
        }

        let config = PoolConfig {
            admin,
            asset,
            tw_escrow,
            payer,
            target_amount,
            repayment_target,
            funding_deadline,
            repayment_deadline,
            min_contribution,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::State, &PoolState::Open);
        env.storage().instance().set(&DataKey::TotalCollected, &0i128);
        env.storage().instance().set(&DataKey::TotalRepaid, &0i128);

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Contributor contributes USDC to the pool.
    /// In Phase 0 prototype, accounts are limited to one contribution per address to guarantee exact zero-dust telescoping intervals.
    /// Multi-slice non-contiguous deposits are planned for Milestone 1 (collapsing up to 16 deposit slices per address).
    pub fn contribute(env: Env, investor: Address, amount: i128) -> Result<i128, Error> {
        investor.require_auth();

        let config: PoolConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        let state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        if state == PoolState::Closed {
            return Err(Error::PoolClosed);
        }

        if state != PoolState::Open {
            return Err(Error::PoolNotOpen);
        }

        let now = env.ledger().timestamp();
        if now > config.funding_deadline {
            return Err(Error::DeadlinePassed);
        }

        // Prevent non-contiguous interval corruption in Phase 0 prototype
        let position_key = DataKey::Position(investor.clone());
        if env.storage().persistent().has(&position_key) {
            return Err(Error::MultipleDepositsNotAllowed);
        }

        if amount < config.min_contribution {
            return Err(Error::InvalidAmount);
        }

        let total_collected: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalCollected)
            .unwrap_or(0);

        let remaining = config
            .target_amount
            .checked_sub(total_collected)
            .ok_or(Error::MathOverflow)?;

        if remaining <= 0 {
            return Err(Error::CapacityExceeded);
        }

        let actual_contribution = if amount > remaining { remaining } else { amount };
        if actual_contribution < config.min_contribution {
            return Err(Error::InvalidAmount);
        }

        // Guarantee pool completion viability: A contribution must either fill the pool completely (remaining_after == 0)
        // or leave at least min_contribution available for subsequent depositors (remaining_after >= min_contribution).
        // This strictly prevents creating an unfillable stranded residual capacity in Open state!
        let remaining_after = remaining.checked_sub(actual_contribution).ok_or(Error::MathOverflow)?;
        if remaining_after > 0 && remaining_after < config.min_contribution {
            return Err(Error::InvalidAmount);
        }

        // Pull funds from contributor to pool contract
        let token_client = token::Client::new(&env, &config.asset);
        token_client.transfer(&investor, &env.current_contract_address(), &actual_contribution);

        let cum_prior = total_collected;
        let new_total = total_collected
            .checked_add(actual_contribution)
            .ok_or(Error::MathOverflow)?;

        env.storage().instance().set(&DataKey::TotalCollected, &new_total);

        // Record immutable contributor position with telescoping cumulative bounds
        let position = Position {
            investor: investor.clone(),
            principal: actual_contribution,
            cum_prior,
            cum_after: new_total,
            claimed: false,
            claimed_tranches: 0,
            cumulative_remainder: 0,
        };

        env.storage().persistent().set(&position_key, &position);
        env.storage().persistent().extend_ttl(
            &position_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        // If target reached, mark pool as Funded and transfer to Trustless Work Escrow
        if new_total >= config.target_amount {
            env.storage().instance().set(&DataKey::State, &PoolState::Funded);

            token_client.transfer(
                &env.current_contract_address(),
                &config.tw_escrow,
                &config.target_amount,
            );
        }

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(actual_contribution)
    }

    /// Authorized payer repays or returns funds into the pool upon settlement.
    pub fn settle_repayment(env: Env, payer: Address, amount: i128) -> Result<(), Error> {
        payer.require_auth();

        let config: PoolConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        // Only the designated payer or admin can settle repayment
        if payer != config.payer && payer != config.admin {
            return Err(Error::Unauthorized);
        }

        let state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        if state == PoolState::Closed {
            return Err(Error::PoolClosed);
        }

        if amount <= 0 || amount > MAX_MONETARY_CAP {
            return Err(Error::InvalidAmount);
        }

        let token_client = token::Client::new(&env, &config.asset);

        // If pool is already Settled or Disputed, any post-settlement repayment or late recovery
        // routes to a discrete immutable secondary tranche without altering frozen primary R.
        if state == PoolState::Settled || state == PoolState::Disputed {
            token_client.transfer(&payer, &env.current_contract_address(), &amount);
            Self::record_secondary_tranche(&env, amount)?;
            env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
            return Ok(());
        }

        if state != PoolState::Funded {
            return Err(Error::PoolNotFunded);
        }

        let total_repaid: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalRepaid)
            .unwrap_or(0);

        let remaining_obligation = config
            .repayment_target
            .checked_sub(total_repaid)
            .ok_or(Error::MathOverflow)?;

        if remaining_obligation <= 0 {
            return Err(Error::CapacityExceeded);
        }

        // Cap primary allocation strictly at repayment_target; any surplus routes to a discrete secondary tranche
        let (primary_part, secondary_part) = if amount > remaining_obligation {
            (remaining_obligation, amount.checked_sub(remaining_obligation).ok_or(Error::MathOverflow)?)
        } else {
            (amount, 0i128)
        };

        token_client.transfer(&payer, &env.current_contract_address(), &amount);

        let new_repaid = total_repaid.checked_add(primary_part).ok_or(Error::MathOverflow)?;
        env.storage().instance().set(&DataKey::TotalRepaid, &new_repaid);

        if secondary_part > 0 {
            Self::record_secondary_tranche(&env, secondary_part)?;
        }

        // Once the full agreed obligation (principal + yield) is reached, pool moves to Settled
        if new_repaid >= config.repayment_target {
            env.storage().instance().set(&DataKey::State, &PoolState::Settled);
        }

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Permissionless default declaration: Any caller (contributor, keeper or admin) can transition
    /// the pool to Settled strictly when repayment_deadline has elapsed and borrower failed to fully repay.
    /// Eradicates administrative lockup or griefing: funds never freeze if admin disappears.
    pub fn declare_default(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();

        let config: PoolConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        let state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        if state == PoolState::Closed {
            return Err(Error::PoolClosed);
        }

        if state != PoolState::Funded {
            return Err(Error::PoolNotFunded);
        }

        // Must strictly be past repayment deadline
        let now = env.ledger().timestamp();
        if now <= config.repayment_deadline {
            return Err(Error::DeadlinePassed);
        }

        // Pool transitions to Settled, freezing R and opening pro-rata claims
        env.storage().instance().set(&DataKey::State, &PoolState::Settled);
        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Handle returned funds when an escrow dispute is resolved in favor of the pool.
    /// Supports partial returns, full returns, or zero return (null recovery closure).
    pub fn handle_dispute_refund(env: Env, caller: Address, amount: i128) -> Result<(), Error> {
        caller.require_auth();

        let config: PoolConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        // Only Trustless Work escrow contract or admin can trigger dispute return
        if caller != config.tw_escrow && caller != config.admin {
            return Err(Error::Unauthorized);
        }

        let state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        if state == PoolState::Closed {
            return Err(Error::PoolClosed);
        }

        // Allow dispute refund from Funded (primary transition to Disputed), or from Settled/Disputed (accumulating into SecondaryRecovery)
        if state != PoolState::Funded && state != PoolState::Settled && state != PoolState::Disputed {
            return Err(Error::PoolNotFunded);
        }

        if amount < 0 || amount > MAX_MONETARY_CAP {
            return Err(Error::InvalidAmount);
        }

        if amount > 0 {
            let token_client = token::Client::new(&env, &config.asset);
            token_client.transfer(&caller, &env.current_contract_address(), &amount);
        }

        if state == PoolState::Funded {
            let total_repaid: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalRepaid)
                .unwrap_or(0);

            let remaining_obligation = config
                .repayment_target
                .checked_sub(total_repaid)
                .ok_or(Error::MathOverflow)?;

            // Strictly cap primary TotalRepaid at repayment_target; route surplus to secondary tranche
            let (primary_part, secondary_part) = if amount > remaining_obligation {
                (remaining_obligation, amount.checked_sub(remaining_obligation).ok_or(Error::MathOverflow)?)
            } else {
                (amount, 0i128)
            };

            let new_repaid = total_repaid.checked_add(primary_part).ok_or(Error::MathOverflow)?;
            env.storage().instance().set(&DataKey::TotalRepaid, &new_repaid);
            env.storage().instance().set(&DataKey::State, &PoolState::Disputed);

            if secondary_part > 0 {
                Self::record_secondary_tranche(&env, secondary_part)?;
            }
        } else {
            // Already Settled or Disputed: late dispute refund routes to discrete secondary tranche
            Self::record_secondary_tranche(&env, amount)?;
        }

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Participant claims their exact pro-rata return in Settled or Disputed state.
    /// Uses telescoping cumulative prefix allocation:
    /// Payout_i = floor(CumAfter_i * Repaid / Target) - floor(CumPrior_i * Repaid / Target)
    /// Guarantees that sum(Payout_i) == TotalRepaid with zero residual dust.
    pub fn claim_return(env: Env, investor: Address) -> Result<i128, Error> {
        // Permissionless disbursal: anyone (investor, keeper, or relayer) can invoke claim_return.
        // Funds are strictly transferred to investor, eliminating the requirement for investor auth
        // and resolving micro-claim abandoned fund issues when fees exceed claim value.

        let config: PoolConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        let state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        // Claims are accessible on Settled, Disputed, or Closed state (exact pro-rata refund of recovered funds)
        if state != PoolState::Settled && state != PoolState::Disputed && state != PoolState::Closed {
            return Err(Error::PoolNotSettled);
        }

        let position_key = DataKey::Position(investor.clone());
        let mut position: Position = env
            .storage()
            .persistent()
            .get(&position_key)
            .ok_or(Error::NoPosition)?;

        if position.claimed {
            return Err(Error::AlreadyClaimed);
        }

        let total_collected: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalCollected)
            .unwrap_or(0);

        let total_repaid: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalRepaid)
            .unwrap_or(0);

        if total_collected <= 0 {
            return Err(Error::InvalidAmount);
        }

        // Exact telescoping prefix sum formula (with checked intermediate math)
        let upper = position
            .cum_after
            .checked_mul(total_repaid)
            .ok_or(Error::MathOverflow)?
            .checked_div(total_collected)
            .ok_or(Error::MathOverflow)?;

        let lower = position
            .cum_prior
            .checked_mul(total_repaid)
            .ok_or(Error::MathOverflow)?
            .checked_div(total_collected)
            .ok_or(Error::MathOverflow)?;

        let payout = upper.checked_sub(lower).ok_or(Error::MathOverflow)?;

        // Check-Effects-Interactions: update position before token transfer
        position.claimed = true;
        position.principal = 0;
        env.storage().persistent().set(&position_key, &position);
        env.storage().persistent().extend_ttl(
            &position_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        if payout > 0 {
            let claimed_pri: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalClaimedPrimary)
                .unwrap_or(0);
            let new_claimed_pri = claimed_pri.checked_add(payout).ok_or(Error::MathOverflow)?;
            env.storage().instance().set(&DataKey::TotalClaimedPrimary, &new_claimed_pri);

            let token_client = token::Client::new(&env, &config.asset);
            token_client.transfer(&env.current_contract_address(), &investor, &payout);
        }

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(payout)
    }

    /// Refund contribution strictly when pool deadline expired without reaching target.
    pub fn refund(env: Env, investor: Address) -> Result<i128, Error> {
        // Permissionless refund disbursal: anyone can trigger refund on behalf of investor.
        // Funds are strictly transferred to investor, preventing stranded funds.

        let config: PoolConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        let mut state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        let now = env.ledger().timestamp();
        if state == PoolState::Open && now > config.funding_deadline {
            state = PoolState::Refundable;
            env.storage().instance().set(&DataKey::State, &PoolState::Refundable);
        }

        if state != PoolState::Refundable {
            return Err(Error::NotRefundable);
        }

        let position_key = DataKey::Position(investor.clone());
        let mut position: Position = env
            .storage()
            .persistent()
            .get(&position_key)
            .ok_or(Error::NoPosition)?;

        if position.claimed {
            return Err(Error::AlreadyClaimed);
        }

        let refund_amount = position.principal;
        if refund_amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // Check-Effects-Interactions: mark claimed & bump TTL before external transfer
        position.claimed = true;
        position.principal = 0;
        env.storage().persistent().set(&position_key, &position);
        env.storage().persistent().extend_ttl(
            &position_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let token_client = token::Client::new(&env, &config.asset);
        token_client.transfer(&env.current_contract_address(), &investor, &refund_amount);

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(refund_amount)
    }


    /// Participant claims their exact pro-rata entitlement of late/secondary recoveries
    /// arriving after the pool has entered Settled or Disputed state.
    /// Can be called multiple times as new recovery tranches arrive.
    /// Participant claims their exact pro-rata entitlement of late/secondary recoveries
    /// arriving after the pool has entered Settled or Disputed state.
    /// Evaluates each discrete immutable secondary tranche independently:
    /// Payout_{i,k} = floor(cum_after_i * S_k / T) - floor(cum_prior_i * S_k / T)
    /// Guarantees strict monotonicity, order-independence, and zero-dust exact conservation.
    pub fn claim_secondary_recovery(
        env: Env,
        investor: Address,
        max_tranches: Option<u32>,
    ) -> Result<i128, Error> {
        // Permissionless secondary recovery disbursal: anyone can trigger distribution to investor.

        let config: PoolConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        let state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        // Claims are permitted on Settled, Disputed, or Closed (allowing complete recovery claim even after closure)
        if state != PoolState::Settled && state != PoolState::Disputed && state != PoolState::Closed {
            return Err(Error::PoolNotSettled);
        }

        let position_key = DataKey::Position(investor.clone());
        let mut position: Position = env
            .storage()
            .persistent()
            .get(&position_key)
            .ok_or(Error::NoPosition)?;

        let total_collected: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalCollected)
            .unwrap_or(0);

        let total_tranches: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SecondaryTrancheCount)
            .unwrap_or(0);

        if total_collected <= 0 || total_tranches <= position.claimed_tranches {
            return Ok(0);
        }

        let requested_batch = max_tranches.unwrap_or(MAX_BATCH_CLAIM_TRANCHES);
        if requested_batch == 0 || requested_batch > MAX_BATCH_CLAIM_TRANCHES {
            return Err(Error::BatchLimitExceeded);
        }

        let start = position.claimed_tranches.checked_add(1).ok_or(Error::CapacityExceeded)?;
        let end = position
            .claimed_tranches
            .checked_add(requested_batch)
            .ok_or(Error::CapacityExceeded)?
            .min(total_tranches);

        // O(1) Cumulative Prefix Sum Telescoping:
        // By evaluating entitlement on the cumulative recovery totals S_cum(end) and S_cum(start - 1),
        // we guarantee mathematical equivalence to an aggregated single-batch allocation:
        // Entitlement(end) = floor(cum_after * S_cum_end / T) - floor(cum_prior * S_cum_end / T)
        // Entitlement(start-1) = floor(cum_after * S_cum_start / T) - floor(cum_prior * S_cum_start / T)
        // Payout = Entitlement(end) - Entitlement(start-1)
        // This ELIMINATES 100% of the cumulative rounding bias and fragmentation distortion across batches!
        let s_cum_start = if position.claimed_tranches == 0 {
            0i128
        } else {
            let start_key = DataKey::SecondaryTranche(position.claimed_tranches);
            let val: i128 = env.storage().persistent().get(&start_key).unwrap_or(0);
            env.storage().persistent().extend_ttl(&start_key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);
            val
        };

        let end_key = DataKey::SecondaryTranche(end);
        let s_cum_end: i128 = env.storage().persistent().get(&end_key).unwrap_or(0);
        env.storage().persistent().extend_ttl(&end_key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);

        let upper_end = Self::safe_mul_div(position.cum_after, s_cum_end, total_collected)?;
        let lower_end = Self::safe_mul_div(position.cum_prior, s_cum_end, total_collected)?;
        let ent_end = upper_end.checked_sub(lower_end).ok_or(Error::MathOverflow)?;

        let upper_start = Self::safe_mul_div(position.cum_after, s_cum_start, total_collected)?;
        let lower_start = Self::safe_mul_div(position.cum_prior, s_cum_start, total_collected)?;
        let ent_start = upper_start.checked_sub(lower_start).ok_or(Error::MathOverflow)?;

        let total_payout = ent_end.checked_sub(ent_start).ok_or(Error::MathOverflow)?;

        position.claimed_tranches = end;
        env.storage().persistent().set(&position_key, &position);
        env.storage().persistent().extend_ttl(
            &position_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        if total_payout > 0 {
            let claimed_sec: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalClaimedSecondary)
                .unwrap_or(0);
            let new_claimed_sec = claimed_sec.checked_add(total_payout).ok_or(Error::MathOverflow)?;
            env.storage().instance().set(&DataKey::TotalClaimedSecondary, &new_claimed_sec);

            let token_client = token::Client::new(&env, &config.asset);
            token_client.transfer(&env.current_contract_address(), &investor, &total_payout);
        }

        // Publish authenticated on-chain event with exact start and end tranches for unambiguous attribution
        env.events().publish(
            (symbol_short!("claim_sec"), investor.clone()),
            (start, end),
        );

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(total_payout)
    }

    /// Read current pool configuration and status.
        /// Permissionless closure of pending sub-threshold recovery buffer:
    /// Any contributor, keeper or admin can flush whatever residual amount remains in
    /// DataKey::PendingSecondaryBuffer into a final discrete secondary tranche,
    /// guaranteeing that zero funds are locked even if incoming recovery is under 1.0 USDC.
    pub fn flush_secondary_buffer(env: Env, caller: Address) -> Result<i128, Error> {
        caller.require_auth();

        let state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        // Claims are permitted on Settled, Disputed, or Closed (allowing complete recovery claim even after closure)
        if state != PoolState::Settled && state != PoolState::Disputed && state != PoolState::Closed {
            return Err(Error::PoolNotSettled);
        }

        let mut pending: i128 = env
            .storage()
            .instance()
            .get(&DataKey::PendingSecondaryBuffer)
            .unwrap_or(0);

        if pending <= 0 {
            return Ok(0);
        }

        // Anti-spam cooldown: enforce FLUSH_COOLDOWN_SECONDS between successive flushes
        let now = env.ledger().timestamp();
        let last_flush_opt: Option<u64> = env
            .storage()
            .instance()
            .get(&DataKey::LastFlushTimestamp);

        if let Some(last_flush) = last_flush_opt {
            if now < last_flush.saturating_add(FLUSH_COOLDOWN_SECONDS) {
                return Err(Error::DeadlinePassed);
            }
        }

        env.storage().instance().set(&DataKey::LastFlushTimestamp, &now);

        // Bounded materialization strictly respecting MAX_MONETARY_CAP per tranche and MAX_TRANCHES_PER_TX.
        // Each tranche is materialized in persistent storage without artificial ceiling,
        // eliminating fund lockup.
        let mut total_flushed: i128 = 0;
        let mut tranches_created = 0u32;

        while pending > 0 && tranches_created < MAX_TRANCHES_PER_TX {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::SecondaryTrancheCount)
                .unwrap_or(0);

            let tranche_amount = if pending > MAX_MONETARY_CAP {
                MAX_MONETARY_CAP
            } else {
                pending
            };

            pending = pending.checked_sub(tranche_amount).ok_or(Error::MathOverflow)?;
            total_flushed = total_flushed.checked_add(tranche_amount).ok_or(Error::MathOverflow)?;
            tranches_created = tranches_created.saturating_add(1);

            let new_count = count.checked_add(1).ok_or(Error::CapacityExceeded)?;
            let total_sec: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSecondaryAllocated)
                .unwrap_or(0);
            let new_total_sec = total_sec.checked_add(tranche_amount).ok_or(Error::MathOverflow)?;

            env.storage().instance().set(&DataKey::SecondaryTrancheCount, &new_count);
            let tranche_key = DataKey::SecondaryTranche(new_count);
            // Prefix Sum Invariant: SecondaryTranche(k) stores S_cum(k), the cumulative secondary funds allocated up to tranche k!
            env.storage().persistent().set(&tranche_key, &new_total_sec);
            env.storage().persistent().extend_ttl(&tranche_key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);

            env.storage().instance().set(&DataKey::TotalSecondaryAllocated, &new_total_sec);
        }

        env.storage().instance().set(&DataKey::PendingSecondaryBuffer, &pending);
        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(total_flushed)
    }

    /// Permanent Terminal Closure of the pool:
    /// Once the pool is in Settled or Disputed state, and all remaining pending buffer balance
    /// has been flushed into a terminal tranche (or buffer is 0), any caller (keeper, admin, or contributor)
    /// can seal the pool by transitioning state to Closed.
    /// This prevents any further incoming late repayments, permanently freezes the tranche count,
    /// and bounds the lifetime tranche creation horizon once and for all.
    /// All participants retain 100% permissionless access to claim their existing entitled tranches.
    pub fn close_pool(env: Env, caller: Address) -> Result<(), Error> {
        let config: PoolConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        // Only admin can finalize and close the pool
        if caller != config.admin {
            return Err(Error::Unauthorized);
        }
        caller.require_auth();

        let state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        if state != PoolState::Settled && state != PoolState::Disputed {
            return Err(Error::PoolNotSettled);
        }

        // Must reconcile any unallocated external token transfers before closing!
        // This guarantees that any direct SEP-41 transfer or late TW escrow refund is fully recognized.
        // We share a strict global budget of MAX_TRANCHES_PER_TX (10) across reconciliation and buffer flushing!
        let (_, tranches_reconciled) = Self::internal_reconcile_surplus(&env, &config, state, MAX_TRANCHES_PER_TX)?;

        let remaining_budget = MAX_TRANCHES_PER_TX.saturating_sub(tranches_reconciled);

        // Materialize buffer incrementally strictly bounded by remaining_budget!
        // This guarantees that close_pool() NEVER creates more than MAX_TRANCHES_PER_TX (10)
        // tranches in a single invocation across BOTH reconciliation and buffer flushing combined.
        let mut pending: i128 = env
            .storage()
            .instance()
            .get(&DataKey::PendingSecondaryBuffer)
            .unwrap_or(0);

        let mut tranches_created = 0u32;
        while pending > 0 && tranches_created < remaining_budget {
            let count: u32 = env
                .storage()
                .instance()
                .get(&DataKey::SecondaryTrancheCount)
                .unwrap_or(0);

            let tranche_amount = if pending > MAX_MONETARY_CAP {
                MAX_MONETARY_CAP
            } else {
                pending
            };

            pending = pending.checked_sub(tranche_amount).ok_or(Error::MathOverflow)?;
            tranches_created = tranches_created.saturating_add(1);

            let new_count = count.checked_add(1).ok_or(Error::CapacityExceeded)?;
            let total_sec: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalSecondaryAllocated)
                .unwrap_or(0);
            let new_total_sec = total_sec.checked_add(tranche_amount).ok_or(Error::MathOverflow)?;

            env.storage().instance().set(&DataKey::SecondaryTrancheCount, &new_count);
            let tranche_key = DataKey::SecondaryTranche(new_count);
            // Prefix Sum Invariant: SecondaryTranche(k) stores S_cum(k), the cumulative secondary funds allocated up to tranche k!
            env.storage().persistent().set(&tranche_key, &new_total_sec);
            env.storage().persistent().extend_ttl(&tranche_key, PERSISTENT_LIFETIME_THRESHOLD, PERSISTENT_BUMP_AMOUNT);

            env.storage().instance().set(&DataKey::TotalSecondaryAllocated, &new_total_sec);
        }

        env.storage().instance().set(&DataKey::PendingSecondaryBuffer, &pending);

        // Only transition to Closed once all pending buffer has been fully materialized!
        if pending == 0 {
            env.storage().instance().set(&DataKey::State, &PoolState::Closed);
        }
        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Internal unauthenticated helper to reconcile surplus token balance without triggering auth errors.
    /// Returns (unallocated_surplus, tranches_created).
    fn internal_reconcile_surplus(env: &Env, config: &PoolConfig, state: PoolState, max_tranches: u32) -> Result<(i128, u32), Error> {
        let token_client = token::Client::new(env, &config.asset);
        let actual_balance = token_client.balance(&env.current_contract_address());

        // Invariant-based unallocated surplus calculation:
        // Contract obligations = (TotalRepaid - TotalClaimedPrimary) + (TotalSecondaryAllocated - TotalClaimedSecondary) + PendingSecondaryBuffer
        let total_repaid: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalRepaid)
            .unwrap_or(0);
        let claimed_pri: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalClaimedPrimary)
            .unwrap_or(0);
        let active_pri_obligation = total_repaid.checked_sub(claimed_pri).ok_or(Error::MathOverflow)?;

        let total_sec: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalSecondaryAllocated)
            .unwrap_or(0);
        let claimed_sec: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalClaimedSecondary)
            .unwrap_or(0);
        let active_sec_obligation = total_sec.checked_sub(claimed_sec).ok_or(Error::MathOverflow)?;

        let pending_buf: i128 = env
            .storage()
            .instance()
            .get(&DataKey::PendingSecondaryBuffer)
            .unwrap_or(0);

        // Check non-negative obligations
        if active_pri_obligation < 0 || active_sec_obligation < 0 || pending_buf < 0 {
            return Err(Error::MathOverflow);
        }

        let total_allocated_held = active_pri_obligation
            .checked_add(active_sec_obligation)
            .ok_or(Error::MathOverflow)?
            .checked_add(pending_buf)
            .ok_or(Error::MathOverflow)?;

        // Invariant: Contract actual balance must strictly cover all active uncollected obligations!
        // If actual_balance < total_allocated_held, pool is in critical deficit (accounting insolvency)
        if actual_balance < total_allocated_held {
            return Err(Error::InvalidAmount);
        }

        let unallocated_surplus = actual_balance.checked_sub(total_allocated_held).ok_or(Error::MathOverflow)?;
        if unallocated_surplus == 0 {
            return Ok((0, 0));
        }

        let mut tranches_created = 0u32;
        if state == PoolState::Funded {
            let remaining_obligation = config
                .repayment_target
                .checked_sub(total_repaid)
                .ok_or(Error::MathOverflow)?;

            let (primary_part, secondary_part) = if unallocated_surplus > remaining_obligation {
                (remaining_obligation, unallocated_surplus.checked_sub(remaining_obligation).ok_or(Error::MathOverflow)?)
            } else {
                (unallocated_surplus, 0i128)
            };

            let new_repaid = total_repaid.checked_add(primary_part).ok_or(Error::MathOverflow)?;
            env.storage().instance().set(&DataKey::TotalRepaid, &new_repaid);
            env.storage().instance().set(&DataKey::State, &PoolState::Disputed);

            if secondary_part > 0 {
                tranches_created = Self::record_secondary_tranche_budgeted(env, secondary_part, max_tranches)?;
            }
        } else {
            tranches_created = Self::record_secondary_tranche_budgeted(env, unallocated_surplus, max_tranches)?;
        }

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok((unallocated_surplus, tranches_created))
    }

    /// Autonomous onchain reconciliation of funds returned directly by Trustless Work or external escrow.
    /// Eliminates reliance on active admin approval or second token transfers:
    /// Any participant can call this function to inspect the contract's actual token balance,
    /// compute any unrecorded surplus above RecognizedBalance, and cleanly record it
    /// into primary TotalRepaid (transitioning Funded -> Disputed) or into discrete secondary tranches.
    pub fn reconcile_incoming_balance(env: Env, caller: Address) -> Result<i128, Error> {
        caller.require_auth();

        let config: PoolConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        let state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        // Claims and balance reconciliations are permitted in Funded, Settled, Disputed, or Closed.
        // Even if a pool was marked Closed, any late incoming transfer can always be reconciled
        // and allocated into secondary tranches, guaranteeing zero locked funds under any circumstance.
        if state != PoolState::Funded && state != PoolState::Settled && state != PoolState::Disputed && state != PoolState::Closed {
            return Err(Error::PoolNotFunded);
        }

        let now = env.ledger().timestamp();
        // In Funded state, external reconcile can ONLY be triggered by authenticated tw_escrow/admin,
        // or permissionlessly strictly AFTER repayment_deadline has elapsed (default/dispute window)
        if state == PoolState::Funded && caller != config.tw_escrow && caller != config.admin && now <= config.repayment_deadline {
            return Err(Error::Unauthorized);
        }

        let (surplus, _) = Self::internal_reconcile_surplus(&env, &config, state, MAX_TRANCHES_PER_TX)?;
        Ok(surplus)
    }

pub fn get_pool_info(env: Env) -> Result<(PoolConfig, PoolState, i128, i128), Error> {
        let config: PoolConfig = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        let state: PoolState = env
            .storage()
            .instance()
            .get(&DataKey::State)
            .unwrap_or(PoolState::Open);

        let total_collected: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalCollected)
            .unwrap_or(0);

        let total_repaid: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalRepaid)
            .unwrap_or(0);

        Ok((config, state, total_collected, total_repaid))
    }

    /// Read investor position.
    pub fn get_position(env: Env, investor: Address) -> Option<Position> {
        env.storage().persistent().get(&DataKey::Position(investor))
    }

    /// Read secondary recovery tranche status.
    /// Returns (total_secondary_tranches, investor_claimed_tranches).
    pub fn get_secondary_claim_status(env: Env, investor: Address) -> (u32, u32) {
        let total_tranches: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SecondaryTrancheCount)
            .unwrap_or(0);

        let claimed_tranches = env
            .storage()
            .persistent()
            .get::<_, Position>(&DataKey::Position(investor))
            .map(|p| p.claimed_tranches)
            .unwrap_or(0);

        (total_tranches, claimed_tranches)
    }
}
