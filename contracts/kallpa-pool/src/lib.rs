#![no_std]

pub mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, token, Address, Env};
use crate::types::{DataKey, Error, PoolConfig, PoolState, Position};

const DAY_IN_LEDGERS: u32 = 17280;
const INSTANCE_BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;

const PERSISTENT_BUMP_AMOUNT: u32 = 60 * DAY_IN_LEDGERS;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 14 * DAY_IN_LEDGERS;

// Maximum intermediate multiplication cap to guarantee i128 intermediate products never overflow
const MAX_MONETARY_CAP: i128 = 10_000_000_000_000_000_000i128; // 10^19 stroops (1 trillion USDC)

#[contract]
pub struct KallpaPoolContract;

#[contractimpl]
impl KallpaPoolContract {
    fn record_secondary_tranche(env: &Env, amount: i128) -> Result<(), Error> {
        if amount <= 0 {
            return Ok(());
        }
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::SecondaryTrancheCount)
            .unwrap_or(0);
        let new_count = count.checked_add(1).ok_or(Error::CapacityExceeded)?;
        env.storage().instance().set(&DataKey::SecondaryTrancheCount, &new_count);
        env.storage().instance().set(&DataKey::SecondaryTranche(new_count), &amount);
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
        if target_amount <= 0 || target_amount > MAX_MONETARY_CAP || repayment_target < target_amount || repayment_target > MAX_MONETARY_CAP || min_contribution <= 0 || min_contribution > target_amount {
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
    /// Multi-slice non-contiguous deposits are planned for Milestone 1.
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

        // Claims are accessible both on Settled and Disputed state (exact pro-rata refund of recovered funds)
        if state != PoolState::Settled && state != PoolState::Disputed {
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
            let token_client = token::Client::new(&env, &config.asset);
            token_client.transfer(&env.current_contract_address(), &investor, &payout);
        }

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(payout)
    }

    /// Refund contribution strictly when pool deadline expired without reaching target.
    pub fn refund(env: Env, investor: Address) -> Result<i128, Error> {
        investor.require_auth();

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
    pub fn claim_secondary_recovery(env: Env, investor: Address) -> Result<i128, Error> {
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

        if state != PoolState::Settled && state != PoolState::Disputed {
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

        let mut total_payout: i128 = 0;
        let start = position.claimed_tranches + 1;
        for tranche_idx in start..=total_tranches {
            let tranche_amount: i128 = env
                .storage()
                .instance()
                .get(&DataKey::SecondaryTranche(tranche_idx))
                .unwrap_or(0);

            if tranche_amount > 0 {
                let upper = position
                    .cum_after
                    .checked_mul(tranche_amount)
                    .ok_or(Error::MathOverflow)?
                    .checked_div(total_collected)
                    .ok_or(Error::MathOverflow)?;

                let lower = position
                    .cum_prior
                    .checked_mul(tranche_amount)
                    .ok_or(Error::MathOverflow)?
                    .checked_div(total_collected)
                    .ok_or(Error::MathOverflow)?;

                let payout = upper.checked_sub(lower).ok_or(Error::MathOverflow)?;
                total_payout = total_payout.checked_add(payout).ok_or(Error::MathOverflow)?;
            }
        }

        position.claimed_tranches = total_tranches;
        env.storage().persistent().set(&position_key, &position);
        env.storage().persistent().extend_ttl(
            &position_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        if total_payout > 0 {
            let token_client = token::Client::new(&env, &config.asset);
            token_client.transfer(&env.current_contract_address(), &investor, &total_payout);
        }

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(total_payout)
    }

    /// Read current pool configuration and status.
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
}
