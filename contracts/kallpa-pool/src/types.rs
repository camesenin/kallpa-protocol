use soroban_sdk::{contracterror, contracttype, Address};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    InvalidAmount = 4,
    DeadlinePassed = 5,
    CapacityExceeded = 6,
    PoolNotOpen = 7,
    PoolNotFunded = 8,
    PoolNotSettled = 9,
    AlreadyClaimed = 10,
    NoPosition = 11,
    NotRefundable = 12,
    MathOverflow = 13,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PoolState {
    Open = 0,
    Funded = 1,
    Settled = 2,
    Refundable = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolConfig {
    pub admin: Address,
    pub asset: Address,
    pub tw_escrow: Address,
    pub target_amount: i128,
    pub deadline: u64,
    pub min_contribution: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub investor: Address,
    pub principal: i128,
    pub claimed: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    State,
    TotalCollected,
    TotalRepaid,
    Position(Address),
    InvestorList,
}
