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

#[contract]
pub struct KallpaPoolContract;

#[contractimpl]
impl KallpaPoolContract {
    /// Initialize the factoring/milestone pool with immutable parameters.
    pub fn initialize(
        env: Env,
        admin: Address,
        asset: Address,
        tw_escrow: Address,
        target_amount: i128,
        deadline: u64,
        min_contribution: i128,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        if target_amount <= 0 || min_contribution <= 0 || min_contribution > target_amount {
            return Err(Error::InvalidAmount);
        }
        if deadline <= env.ledger().timestamp() {
            return Err(Error::DeadlinePassed);
        }

        let config = PoolConfig {
            admin,
            asset,
            tw_escrow,
            target_amount,
            deadline,
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
        if now > config.deadline {
            env.storage().instance().set(&DataKey::State, &PoolState::Refundable);
            return Err(Error::DeadlinePassed);
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

        // Update persistent contributor position with telescoping cumulative bounds
        let position_key = DataKey::Position(investor.clone());
        let mut position = env
            .storage()
            .persistent()
            .get(&position_key)
            .unwrap_or(Position {
                investor: investor.clone(),
                principal: 0,
                cum_prior,
                cum_after: new_total,
                claimed: false,
            });

        position.principal = position
            .principal
            .checked_add(actual_contribution)
            .ok_or(Error::MathOverflow)?;
        position.cum_after = new_total;

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

    /// Payer / Escrow repays or returns funds into the pool upon settlement.
    pub fn settle_repayment(env: Env, payer: Address, amount: i128) -> Result<(), Error> {
        payer.require_auth();

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

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let token_client = token::Client::new(&env, &config.asset);
        token_client.transfer(&payer, &env.current_contract_address(), &amount);

        let total_repaid: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalRepaid)
            .unwrap_or(0);

        let new_repaid = total_repaid.checked_add(amount).ok_or(Error::MathOverflow)?;
        env.storage().instance().set(&DataKey::TotalRepaid, &new_repaid);
        env.storage().instance().set(&DataKey::State, &PoolState::Settled);

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Participant claims their exact pro-rata return.
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

        if state != PoolState::Settled {
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

        // Exact telescoping prefix sum formula
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

        position.claimed = true;
        env.storage().persistent().set(&position_key, &position);
        env.storage().persistent().extend_ttl(
            &position_key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );

        let token_client = token::Client::new(&env, &config.asset);
        token_client.transfer(&env.current_contract_address(), &investor, &payout);

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(payout)
    }

    /// Refund contribution if pool deadline expired without reaching target.
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
        if state == PoolState::Open && now > config.deadline {
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

        position.claimed = true;
        position.principal = 0;
        env.storage().persistent().set(&position_key, &position);

        let token_client = token::Client::new(&env, &config.asset);
        token_client.transfer(&env.current_contract_address(), &investor, &refund_amount);

        env.storage().instance().extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(refund_amount)
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
