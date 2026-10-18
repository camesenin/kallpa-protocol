#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

fn create_token_contract<'a>(e: &Env, admin: &Address) -> (Address, StellarAssetClient<'a>, token::Client<'a>) {
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    (
        sac.address(),
        StellarAssetClient::new(e, &sac.address()),
        token::Client::new(e, &sac.address()),
    )
}

#[allow(dead_code)]
struct TestSetup<'a> {
    env: Env,
    admin: Address,
    investor1: Address,
    investor2: Address,
    tw_escrow: Address,
    payer: Address,
    token_addr: Address,
    token_admin: StellarAssetClient<'a>,
    token_client: token::Client<'a>,
    contract_id: Address,
    client: KallpaPoolContractClient<'a>,
}

fn setup_test<'a>() -> TestSetup<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let investor1 = Address::generate(&env);
    let investor2 = Address::generate(&env);
    let tw_escrow = Address::generate(&env);
    let payer = Address::generate(&env);

    let (token_addr, token_admin, token_client) = create_token_contract(&env, &admin);

    // Mint test funds
    token_admin.mint(&investor1, &100_000_0000000); // 100k USDC
    token_admin.mint(&investor2, &100_000_0000000); // 100k USDC
    token_admin.mint(&payer, &200_000_0000000);     // 200k USDC

    let contract_id = env.register(KallpaPoolContract, ());
    let client = KallpaPoolContractClient::new(&env, &contract_id);

    TestSetup {
        env,
        admin,
        investor1,
        investor2,
        tw_escrow,
        payer,
        token_addr,
        token_admin,
        token_client,
        contract_id,
        client,
    }
}

#[test]
fn test_successful_pool_lifecycle() {
    let setup = setup_test();
    let target = 10_000_0000000i128; // 10,000 USDC
    let deadline = setup.env.ledger().timestamp() + 3600; // 1 hour
    let min_contribution = 100_0000000i128; // 100 USDC

    // 1. Initialize
    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &target,
        &deadline,
        &min_contribution,
    );

    let (config, state, total, repaid) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Open);
    assert_eq!(total, 0);
    assert_eq!(repaid, 0);
    assert_eq!(config.target_amount, target);

    // 2. Investor 1 contributes 6,000 USDC (60%)
    let contrib1 = 6_000_0000000i128;
    let actual1 = setup.client.contribute(&setup.investor1, &contrib1);
    assert_eq!(actual1, contrib1);

    let pos1 = setup.client.get_position(&setup.investor1).unwrap();
    assert_eq!(pos1.principal, contrib1);
    assert_eq!(pos1.claimed, false);

    let (_, state_mid, total_mid, _) = setup.client.get_pool_info();
    assert_eq!(state_mid, PoolState::Open);
    assert_eq!(total_mid, contrib1);

    // 3. Investor 2 contributes 4,000 USDC (40%) -> reaches target!
    let contrib2 = 4_000_0000000i128;
    let actual2 = setup.client.contribute(&setup.investor2, &contrib2);
    assert_eq!(actual2, contrib2);

    let (_, state_funded, total_funded, _) = setup.client.get_pool_info();
    assert_eq!(state_funded, PoolState::Funded);
    assert_eq!(total_funded, target);

    // Check that TW escrow received the target 10,000 USDC
    let tw_balance = setup.token_client.balance(&setup.tw_escrow);
    assert_eq!(tw_balance, target);

    // 4. Debtor / Payer repays invoice with 10% interest (11,000 USDC)
    let repayment = 11_000_0000000i128;
    setup.client.settle_repayment(&setup.payer, &repayment);

    let (_, state_settled, _, total_repaid) = setup.client.get_pool_info();
    assert_eq!(state_settled, PoolState::Settled);
    assert_eq!(total_repaid, repayment);

    // 5. Investor 1 claims return: should get 60% of 11,000 = 6,600 USDC
    let inv1_bal_before = setup.token_client.balance(&setup.investor1);
    let payout1 = setup.client.claim_return(&setup.investor1);
    assert_eq!(payout1, 6_600_0000000i128);
    let inv1_bal_after = setup.token_client.balance(&setup.investor1);
    assert_eq!(inv1_bal_after - inv1_bal_before, 6_600_0000000i128);

    // 6. Investor 2 claims return: should get 40% of 11,000 = 4,400 USDC
    let inv2_bal_before = setup.token_client.balance(&setup.investor2);
    let payout2 = setup.client.claim_return(&setup.investor2);
    assert_eq!(payout2, 4_400_0000000i128);
    let inv2_bal_after = setup.token_client.balance(&setup.investor2);
    assert_eq!(inv2_bal_after - inv2_bal_before, 4_400_0000000i128);

    // Total claims must exactly equal repayment: 6,600 + 4,400 = 11,000
    assert_eq!(payout1 + payout2, repayment);
}

#[test]
fn test_refund_on_expired_deadline() {
    let setup = setup_test();
    let target = 10_000_0000000i128;
    let deadline = setup.env.ledger().timestamp() + 1000;
    let min_contribution = 100_0000000i128;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &target,
        &deadline,
        &min_contribution,
    );

    // Investor 1 contributes 3,000 USDC
    let contrib = 3_000_0000000i128;
    setup.client.contribute(&setup.investor1, &contrib);

    // Fast-forward ledger past deadline
    setup.env.ledger().set_timestamp(deadline + 500);

    // Investor 1 requests refund
    let bal_before = setup.token_client.balance(&setup.investor1);
    let refunded = setup.client.refund(&setup.investor1);
    assert_eq!(refunded, contrib);
    let bal_after = setup.token_client.balance(&setup.investor1);
    assert_eq!(bal_after - bal_before, contrib);
}

#[test]
fn test_exact_zero_dust_telescoping_pro_rata() {
    let setup = setup_test();
    let investor3 = Address::generate(&setup.env);
    setup.token_admin.mint(&investor3, &100_000_0000000);

    let target = 10_000_0000000i128; // 10,000 USDC
    let deadline = setup.env.ledger().timestamp() + 3600;
    let min_contribution = 1_0000000i128;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &target,
        &deadline,
        &min_contribution,
    );

    // 3 unequal contributors dividing by 3:
    // Inv1: 3,333.3333333 USDC
    // Inv2: 3,333.3333333 USDC
    // Inv3: 3,333.3333334 USDC
    // Total = 10,000.0000000 USDC
    let c1 = 3_333_3333333i128;
    let c2 = 3_333_3333333i128;
    let c3 = 3_333_3333334i128;

    setup.client.contribute(&setup.investor1, &c1);
    setup.client.contribute(&setup.investor2, &c2);
    setup.client.contribute(&investor3, &c3);

    // Repayment with prime amount creating recurring fractions: 11,337.7777777 USDC
    let repayment = 11_337_7777777i128;
    setup.client.settle_repayment(&setup.payer, &repayment);

    let p1 = setup.client.claim_return(&setup.investor1);
    let p2 = setup.client.claim_return(&setup.investor2);
    let p3 = setup.client.claim_return(&investor3);

    // INVARIANT: sum of individual payouts MUST EXACTLY equal total repayment with ZERO dust residual
    assert_eq!(p1 + p2 + p3, repayment);
}

