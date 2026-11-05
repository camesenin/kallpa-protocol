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
    MultipleDepositsNotAllowed = 14,
    PoolNotDisputed = 15,
    PoolAlreadySettled = 16,
    RepaymentDeadlinePassed = 17,
    AmountBelowMinRecovery = 18,
    BatchLimitExceeded = 19,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum PoolState {
    Open = 0,
    Funded = 1,
    Settled = 2,
    Refundable = 3,
    Disputed = 4,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolConfig {
    pub admin: Address,
    pub asset: Address,
    pub tw_escrow: Address,
    pub payer: Address,
    pub target_amount: i128,
    pub repayment_target: i128,
    pub funding_deadline: u64,
    pub repayment_deadline: u64,
    pub min_contribution: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub investor: Address,
    pub principal: i128,
    pub cum_prior: i128,
    pub cum_after: i128,
    pub claimed: bool,
    pub claimed_tranches: u32,
    pub cumulative_remainder: i128,
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
    SecondaryTrancheCount,
    SecondaryTranche(u32),
    PendingSecondaryBuffer,
    LastFlushTimestamp,
    RecognizedBalance,
}
