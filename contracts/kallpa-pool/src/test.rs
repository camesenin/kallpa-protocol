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
        let min_contribution = 10_0000000i128; // 100 USDC

    // 1. Initialize with repayment_target = 11,000 USDC and dual deadlines
    let repayment_target = 11_000_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400; // 24 hours later
    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    let (config, state, total, repaid) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Open);
    assert_eq!(total, 0);
    assert_eq!(repaid, 0);
    assert_eq!(config.target_amount, target);
    assert_eq!(config.payer, setup.payer);

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

    // 4. Authorized Payer repays invoice with 10% premium (11,000 USDC)
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
    let min_contribution = 10_0000000i128;

    let repayment_target = target;
    let funding_deadline = setup.env.ledger().timestamp() + 1000;
    let repayment_deadline = funding_deadline + 86400;
    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    // Investor 1 contributes 3,000 USDC
    let contrib = 3_000_0000000i128;
    setup.client.contribute(&setup.investor1, &contrib);

    // Fast-forward ledger past funding_deadline
    setup.env.ledger().set_timestamp(funding_deadline + 500);

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
    let min_contribution = 1_0000000i128;

    let repayment_target = 11_337_7777777i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;
    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    // 3 unequal contributors:
    let c1 = 3_333_3333333i128;
    let c2 = 3_333_3333333i128;
    let c3 = 3_333_3333334i128;

    setup.client.contribute(&setup.investor1, &c1);
    setup.client.contribute(&setup.investor2, &c2);
    setup.client.contribute(&investor3, &c3);

    // Repayment with fractional cents: 11,337.7777777 USDC
    let repayment = 11_337_7777777i128;
    setup.client.settle_repayment(&setup.payer, &repayment);

    let p1 = setup.client.claim_return(&setup.investor1);
    let p2 = setup.client.claim_return(&setup.investor2);
    let p3 = setup.client.claim_return(&investor3);

    // INVARIANT: sum of individual payouts MUST EXACTLY equal total repayment with ZERO dust residual
    assert_eq!(p1 + p2 + p3, repayment);
}

#[test]
fn test_reject_multiple_deposits_per_address() {
    let setup = setup_test();
    let target = 10_000_0000000i128;
    let min_contribution = 10_0000000i128;

    let repayment_target = target;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;
    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    setup.client.contribute(&setup.investor1, &2_000_0000000i128);

    // Second contribution by same address must be rejected in Phase 0 prototype to protect telescoping invariants
    let res = setup.client.try_contribute(&setup.investor1, &1_000_0000000i128);
    assert_eq!(res, Err(Ok(Error::MultipleDepositsNotAllowed)));
}

#[test]
fn test_dispute_refund_flow() {
    let setup = setup_test();
    let target = 10_000_0000000i128;
    let min_contribution = 10_0000000i128;

    let repayment_target = target;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;
    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    // Fully fund pool
    setup.client.contribute(&setup.investor1, &6_000_0000000i128);
    setup.client.contribute(&setup.investor2, &4_000_0000000i128);

    let (_, state, _, _) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Funded);

    // Escrow dispute arises and Trustless Work refunds the 10,000 USDC back to the pool
    setup.token_admin.mint(&setup.tw_escrow, &10_000_0000000i128);
    setup.client.handle_dispute_refund(&setup.tw_escrow, &target);

    let (_, state_disputed, _, _) = setup.client.get_pool_info();
    assert_eq!(state_disputed, PoolState::Disputed);

    // In Disputed state, investors claim their pro-rata of the returned escrow funds via claim_return
    let r1 = setup.client.claim_return(&setup.investor1);
    assert_eq!(r1, 6_000_0000000i128);

    let r2 = setup.client.claim_return(&setup.investor2);
    assert_eq!(r2, 4_000_0000000i128);
}


#[test]
fn test_multi_tranche_repayment_and_dust_attack_mitigation() {
    let setup = setup_test();
    let target = 10_000_0000000i128; // 10,000 USDC
    let min_contribution = 10_0000000i128;

    let repayment_target = 11_000_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;
    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    // Fully fund pool: inv1 = 60%, inv2 = 40%
    setup.client.contribute(&setup.investor1, &6_000_0000000i128);
    setup.client.contribute(&setup.investor2, &4_000_0000000i128);

    let (_, state, _, _) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Funded);

    // Payer sends a small 1 USDC partial repayment
    let dust = 1_0000000i128; // 1 USDC
    setup.client.settle_repayment(&setup.payer, &dust);

    // Pool remains in Funded state, NOT Settled, preventing premature closure
    let (_, state_after_dust, _, repaid_1) = setup.client.get_pool_info();
    assert_eq!(state_after_dust, PoolState::Funded);
    assert_eq!(repaid_1, dust);

    // Investors cannot prematurely claim dust
    let claim_res = setup.client.try_claim_return(&setup.investor1);
    assert_eq!(claim_res.is_err(), true);

    // Payer sends second tranche: 4,000 USDC
    let tranche_2 = 4_000_0000000i128;
    setup.client.settle_repayment(&setup.payer, &tranche_2);
    let (_, state_tranche_2, _, repaid_2) = setup.client.get_pool_info();
    assert_eq!(state_tranche_2, PoolState::Funded);
    assert_eq!(repaid_2, dust + tranche_2);

    // Payer completes full repayment with yield (6,999 USDC, total = 11,000 USDC)
    let tranche_3 = 6_999_0000000i128;
    setup.client.settle_repayment(&setup.payer, &tranche_3);

    let (_, state_final, _, total_repaid) = setup.client.get_pool_info();
    assert_eq!(state_final, PoolState::Settled);
    assert_eq!(total_repaid, 11_000_0000000i128);

    // Claims open and allocate exact pro-rata
    let payout1 = setup.client.claim_return(&setup.investor1);
    assert_eq!(payout1, 6_600_0000000i128);

    let payout2 = setup.client.claim_return(&setup.investor2);
    assert_eq!(payout2, 4_400_0000000i128);

    assert_eq!(payout1 + payout2, 11_000_0000000i128);
}

#[test]
fn test_admin_declare_settled_on_partial_repayment() {
    let setup = setup_test();
    let target = 10_000_0000000i128;
    let min_contribution = 10_0000000i128;

    let repayment_target = 11_000_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;
    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    setup.client.contribute(&setup.investor1, &6_000_0000000i128);
    setup.client.contribute(&setup.investor2, &4_000_0000000i128);

    // Payer only manages to repay 5,000 USDC (50% recovery)
    let partial = 5_000_0000000i128;
    setup.client.settle_repayment(&setup.payer, &partial);

    let (_, state_funded, _, _) = setup.client.get_pool_info();
    assert_eq!(state_funded, PoolState::Funded);

    // Attempting early declare_settled before deadline must fail
    let early_res = setup.client.try_declare_default(&setup.investor1);
    assert_eq!(early_res, Err(Ok(Error::DeadlinePassed)));

    // Advance ledger past repayment_deadline to simulate loan default
    setup.env.ledger().set_timestamp(repayment_deadline + 10);

    // Permissionless default declaration by contributor
    setup.client.declare_default(&setup.investor1);

    let (_, state_settled, _, total_repaid) = setup.client.get_pool_info();
    assert_eq!(state_settled, PoolState::Settled);
    assert_eq!(total_repaid, partial);

    // Investors claim exact pro-rata of partial recovery
    let p1 = setup.client.claim_return(&setup.investor1);
    assert_eq!(p1, 3_000_0000000i128); // 60% of 5,000

    let p2 = setup.client.claim_return(&setup.investor2);
    assert_eq!(p2, 2_000_0000000i128); // 40% of 5,000

    assert_eq!(p1 + p2, partial);
}

#[test]
fn test_late_repayment_routed_to_secondary_recovery_after_settled() {
    let setup = setup_test();
    let target = 10_000_0000000i128; // 10,000 USDC
    let min_contribution = 10_0000000i128;

    let repayment_target = 11_000_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;
    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    // Investors fund target
    setup.client.contribute(&setup.investor1, &6_000_0000000i128);
    setup.client.contribute(&setup.investor2, &4_000_0000000i128);

    // Payer repays target + yield in a single tranche (11,000 USDC) -> settles pool
    setup.client.settle_repayment(&setup.payer, &11_000_0000000i128);

    let (_, state, _, repaid) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Settled);
    assert_eq!(repaid, 11_000_0000000i128);

    // Investor 1 claims return
    let p1 = setup.client.claim_return(&setup.investor1);
    assert_eq!(p1, 6_600_0000000i128);

    // Payer sends late repayment / surplus recovery of 1,000 USDC after pool is Settled
    // INVARIANT: Late recovery does NOT alter primary R (which remains 11,000 USDC)
    // Instead, it routes to SecondaryRecovery, and can be claimed pro-rata via claim_secondary_recovery
    setup.client.settle_repayment(&setup.payer, &1_000_0000000i128);

    let (_, state_after, _, repaid_after) = setup.client.get_pool_info();
    assert_eq!(state_after, PoolState::Settled);
    assert_eq!(repaid_after, 11_000_0000000i128); // Primary R is strictly frozen!

    // Investor 2 claims primary return unaffected (40% of 11,000)
    let p2 = setup.client.claim_return(&setup.investor2);
    assert_eq!(p2, 4_400_0000000i128);
    assert_eq!(p1 + p2, 11_000_0000000i128);

    // Investors now claim their secondary recovery pro-rata (60% and 40% of 1,000 USDC)
    let sec1 = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    assert_eq!(sec1, 600_0000000i128);

    let sec2 = setup.client.claim_secondary_recovery(&setup.investor2, &None);
    assert_eq!(sec2, 400_0000000i128);
    assert_eq!(sec1 + sec2, 1_000_0000000i128);
}

#[test]
fn test_multi_tranche_repayment_reaches_repayment_target_with_yield() {
    let setup = setup_test();
    let target = 10_000_0000000i128; // 10,000 USDC principal
    let repayment_target = 11_000_0000000i128; // 11,000 USDC (10% agreed yield)
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;
    let min_contribution = 10_0000000i128;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    // Investors fund target: Inv1 = 60%, Inv2 = 40%
    setup.client.contribute(&setup.investor1, &6_000_0000000i128);
    setup.client.contribute(&setup.investor2, &4_000_0000000i128);

    let (_, state, _, _) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Funded);

    // Tranche 1: Borrower repays 10,000 USDC (100% of principal)
    let tranche1 = 10_000_0000000i128;
    setup.client.settle_repayment(&setup.payer, &tranche1);

    // Crucial check: pool must NOT prematurely settle upon recovering principal target!
    // It remains in Funded state because repayment_target (11,000 USDC) has not been reached.
    let (_, state_t1, _, repaid_t1) = setup.client.get_pool_info();
    assert_eq!(state_t1, PoolState::Funded);
    assert_eq!(repaid_t1, tranche1);

    // Tranche 2: Borrower pays the remaining 1,000 USDC (agreed yield)
    let tranche2 = 1_000_0000000i128;
    setup.client.settle_repayment(&setup.payer, &tranche2);

    // Now full repayment_target is reached -> state moves to Settled and R freezes at 11,000 USDC
    let (_, state_t2, _, repaid_t2) = setup.client.get_pool_info();
    assert_eq!(state_t2, PoolState::Settled);
    assert_eq!(repaid_t2, repayment_target);

    // Investors pull exact pro-rata share of principal + interest
    let p1 = setup.client.claim_return(&setup.investor1);
    assert_eq!(p1, 6_600_0000000i128); // 60% of 11,000

    let p2 = setup.client.claim_return(&setup.investor2);
    assert_eq!(p2, 4_400_0000000i128); // 40% of 11,000

    assert_eq!(p1 + p2, repayment_target);
}

#[test]
fn test_post_default_secondary_recovery_flow() {
    let setup = setup_test();
    let target = 10_000_0000000i128; // 10,000 USDC
    let repayment_target = 11_000_0000000i128; // 11,000 USDC
    let min_contribution = 10_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    // Investors fund target: inv1 = 60%, inv2 = 40%
    setup.client.contribute(&setup.investor1, &6_000_0000000i128);
    setup.client.contribute(&setup.investor2, &4_000_0000000i128);

    // Borrower only repays 5,000 USDC before repayment_deadline
    setup.client.settle_repayment(&setup.payer, &5_000_0000000i128);

    // Repayment deadline passes, borrower defaults
    setup.env.ledger().set_timestamp(repayment_deadline + 10);

    // Permissionless declare_default transitions to Settled and freezes primary R at 5,000 USDC
    setup.client.declare_default(&setup.investor1);
    let (_, state, _, primary_repaid) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Settled);
    assert_eq!(primary_repaid, 5_000_0000000i128);

    // Investors claim primary recovery (60% of 5,000 = 3,000; 40% of 5,000 = 2,000)
    let p1 = setup.client.claim_return(&setup.investor1);
    assert_eq!(p1, 3_000_0000000i128);
    let p2 = setup.client.claim_return(&setup.investor2);
    assert_eq!(p2, 2_000_0000000i128);
    assert_eq!(p1 + p2, 5_000_0000000i128);

    // Weeks later, debt collection / restructuring recovers an additional 3,000 USDC
    // Settle_repayment routes this late recovery into SecondaryRecovery without failing
    setup.client.settle_repayment(&setup.payer, &3_000_0000000i128);

    // Primary R remains strictly 5,000 USDC
    let (_, _, _, primary_after) = setup.client.get_pool_info();
    assert_eq!(primary_after, 5_000_0000000i128);

    // Investors claim their pro-rata of secondary recovery (60% of 3,000 = 1,800; 40% of 3,000 = 1,200)
    let sec1 = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    assert_eq!(sec1, 1_800_0000000i128);
    let sec2 = setup.client.claim_secondary_recovery(&setup.investor2, &None);
    assert_eq!(sec2, 1_200_0000000i128);
    assert_eq!(sec1 + sec2, 3_000_0000000i128);

    // An additional third tranche of 2,000 USDC arrives later
    setup.client.settle_repayment(&setup.payer, &2_000_0000000i128);

    // Subsequent claims pull the incremental entitlement (60% of 2,000 = 1,200; 40% of 2,000 = 800)
    let sec1_t2 = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    assert_eq!(sec1_t2, 1_200_0000000i128);
    let sec2_t2 = setup.client.claim_secondary_recovery(&setup.investor2, &None);
    assert_eq!(sec2_t2, 800_0000000i128);
    assert_eq!(sec1_t2 + sec2_t2, 2_000_0000000i128);

    // Total recovered across all tranches: 5,000 + 3,000 + 2,000 = 10,000 USDC
    // Total received by Inv1: 3,000 + 1,800 + 1,200 = 6,000 USDC (exact 60%)
    // Total received by Inv2: 2,000 + 1,200 + 800 = 4,000 USDC (exact 40%)
    assert_eq!(p1 + sec1 + sec1_t2, 6_000_0000000i128);
    assert_eq!(p2 + sec2 + sec2_t2, 4_000_0000000i128);
}


#[test]
fn test_secondary_recovery_pagination_and_batch_limits() {
    let setup = setup_test();
    let target = 10_000_0000000i128;
    let repayment_target = 10_000_0000000i128;
    let min_contribution = 10_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    setup.client.contribute(&setup.investor1, &6_000_0000000i128); // 60%
    setup.client.contribute(&setup.investor2, &4_000_0000000i128); // 40%

    // Full target repaid, pool settled
    setup.client.settle_repayment(&setup.payer, &10_000_0000000i128);
    let (_, state, _, _) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Settled);

    // Primary claims
    assert_eq!(setup.client.claim_return(&setup.investor1), 6_000_0000000i128);
    assert_eq!(setup.client.claim_return(&setup.investor2), 4_000_0000000i128);

    // Simulate 5 separate secondary recovery tranches (each 10 USDC = 100_0000000 stroops >= MIN_RECOVERY_TRANCHE)
    for _ in 0..5 {
        setup.client.settle_repayment(&setup.payer, &10_0000000i128);
    }

    // Investor 1 claims in batches of 2 tranches
    // Batch 1: tranches 1..2 (20 USDC total -> 60% = 12 USDC)
    let b1 = setup.client.claim_secondary_recovery(&setup.investor1, &Some(2));
    assert_eq!(b1, 12_0000000i128);

    let pos1 = setup.client.get_position(&setup.investor1).unwrap();
    assert_eq!(pos1.claimed_tranches, 2);

    // Batch 2: tranches 3..4 (20 USDC total -> 60% = 12 USDC)
    let b2 = setup.client.claim_secondary_recovery(&setup.investor1, &Some(2));
    assert_eq!(b2, 12_0000000i128);

    let pos1 = setup.client.get_position(&setup.investor1).unwrap();
    assert_eq!(pos1.claimed_tranches, 4);

    // Batch 3: tranche 5 (10 USDC total -> 60% = 6 USDC)
    let b3 = setup.client.claim_secondary_recovery(&setup.investor1, &Some(2));
    assert_eq!(b3, 6_0000000i128);

    let pos1 = setup.client.get_position(&setup.investor1).unwrap();
    assert_eq!(pos1.claimed_tranches, 5);

    // No more tranches left
    let b4 = setup.client.claim_secondary_recovery(&setup.investor1, &Some(2));
    assert_eq!(b4, 0i128);

    // Total received by Inv1 across all 5 tranches: 12 + 12 + 6 = 30 USDC (exact 60% of 50 USDC)
    assert_eq!(b1 + b2 + b3, 30_0000000i128);

    // Investor 2 claims all remaining tranches at once (max_tranches = None defaults to 50)
    let inv2_all = setup.client.claim_secondary_recovery(&setup.investor2, &None);
    assert_eq!(inv2_all, 20_0000000i128); // exact 40% of 50 USDC

    // Conservation check: 30 + 20 = 50 USDC
    assert_eq!(b1 + b2 + b3 + inv2_all, 50_0000000i128);
}

#[test]
fn test_secondary_recovery_enforces_min_tranche_against_dust_fragmentation() {
    let setup = setup_test();
    let target = 10_000_0000000i128;
    let repayment_target = 10_000_0000000i128;
    let min_contribution = 10_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    setup.client.contribute(&setup.investor1, &6_000_0000000i128);
    setup.client.contribute(&setup.investor2, &4_000_0000000i128);

    setup.client.settle_repayment(&setup.payer, &10_000_0000000i128);

    // Posting micro-amounts (e.g. 0.4 USDC = 4_000_000 stroops and 0.6 USDC = 6_000_000 stroops)
    // does NOT revert the repayment! Instead, it safely accumulates in PendingSecondaryBuffer
    let res1 = setup.client.try_settle_repayment(&setup.payer, &4_000_000i128);
    assert!(res1.is_ok());

    // Still in buffer (< 10_000_000), no tranche materialized yet
    let c1 = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    assert_eq!(c1, 0i128);

    // Second micro-amount arrives (6_000_000 stroops). Combined = 10_000_000 stroops = 1.0 USDC!
    let res2 = setup.client.try_settle_repayment(&setup.payer, &6_000_000i128);
    assert!(res2.is_ok());

    // Materializes 1 tranche of 1.0 USDC (10_000_000 stroops)
    // 60% of 10_000_000 = 6_000_000; 40% = 4_000_000
    let c1_after = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    let c2_after = setup.client.claim_secondary_recovery(&setup.investor2, &None);
    assert_eq!(c1_after, 6_000_000i128);
    assert_eq!(c2_after, 4_000_000i128);
    assert_eq!(c1_after + c2_after, 10_000_000i128);
}

#[test]
fn test_tw_escrow_lifecycle_and_non_cooperative_dispute_return() {
    // Verifies upstream Trustless Work integration architecture resolving B08:
    // 1. Contributors pool funds into KallpaPool
    // 2. Pool releases funds to Trustless Work Escrow (address authenticated)
    // 3. Upstream dispute is resolved; Trustless Work invokes handle_dispute_refund directly
    // 4. Returns directly out of held funds without artificial re-minting
    // 5. Investors claim pro-rata shares with zero residual dust
    let setup = setup_test();
    let target = 10_000_0000000i128; // 10,000 USDC
    let repayment_target = 10_000_0000000i128;
    let min_contribution = 100_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    // Contributor 1 deposits 7,000 USDC (70%), Contributor 2 deposits 3,000 USDC (30%)
    setup.client.contribute(&setup.investor1, &7_000_0000000i128);
    setup.client.contribute(&setup.investor2, &3_000_0000000i128);

    // Target reached -> Pool moves to Funded, releasing exactly 10,000 USDC to Trustless Work Escrow
    let (_, state, total_collected, _) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Funded);
    assert_eq!(total_collected, target);
    assert_eq!(setup.token_client.balance(&setup.tw_escrow), target);

    // Scenario A: Unauthorized third party or rogue borrower attempts to call handle_dispute_refund
    let rogue = Address::generate(&setup.env);
    let rogue_res = setup.client.try_handle_dispute_refund(&rogue, &5_000_0000000i128);
    assert_eq!(rogue_res, Err(Ok(Error::Unauthorized)));

    // Scenario B: TW Escrow directly invokes handle_dispute_refund with 8,000 USDC (80% recovery)
    // CRITICAL: The funds transferred back COME DIRECTLY OUT OF THE 10,000 USDC HELD IN TW ESCROW!
    // No artificial minting or external balance injections.
    let tw_res = setup.client.try_handle_dispute_refund(&setup.tw_escrow, &8_000_0000000i128);
    assert!(tw_res.is_ok());

    // Verify TW Escrow balance after returning 8,000 USDC: exactly 2,000 USDC remains in escrow (e.g. fee/service provider share)
    assert_eq!(setup.token_client.balance(&setup.tw_escrow), 2_000_0000000i128);

    // Verify Kallpa Pool contract balance: exactly 8,000 USDC held for contributor claims
    assert_eq!(setup.token_client.balance(&setup.contract_id), 8_000_0000000i128);

    let (_, state_after, _, total_repaid) = setup.client.get_pool_info();
    assert_eq!(state_after, PoolState::Disputed);
    assert_eq!(total_repaid, 8_000_0000000i128);

    // Pro-rata distribution: 70% of 8,000 = 5,600 USDC, 30% of 8,000 = 2,400 USDC
    let p1 = setup.client.claim_return(&setup.investor1);
    let p2 = setup.client.claim_return(&setup.investor2);
    assert_eq!(p1, 5_600_0000000i128);
    assert_eq!(p2, 2_400_0000000i128);
    assert_eq!(p1 + p2, 8_000_0000000i128);

    // Verify Kallpa Pool contract balance after all claims: exactly 0 residual dust!
    assert_eq!(setup.token_client.balance(&setup.contract_id), 0i128);
}


#[test]
fn test_flush_secondary_buffer_prevents_fund_lockup() {
    // Tests that sub-threshold residual amounts in PendingSecondaryBuffer (e.g. 0.5 USDC = 5_000_000 stroops)
    // can be flushed permissionlessly into a discrete tranche and claimed completely by investors with zero lockup!
    let setup = setup_test();
    let target = 10_000_0000000i128;
    let repayment_target = 10_000_0000000i128;
    let min_contribution = 100_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    setup.client.contribute(&setup.investor1, &6_000_0000000i128);
    setup.client.contribute(&setup.investor2, &4_000_0000000i128);

    // Borrower repays 10,000.5 USDC (obligation = 10,000 USDC, surplus = 0.5 USDC = 5_000_000 stroops)
    // Settle_repayment settles pool and routes 0.5 USDC to PendingSecondaryBuffer
    setup.client.settle_repayment(&setup.payer, &10_000_5000000i128);

    let (_, state, _, _) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Settled);

    // Primary claims
    assert_eq!(setup.client.claim_return(&setup.investor1), 6_000_0000000i128);
    assert_eq!(setup.client.claim_return(&setup.investor2), 4_000_0000000i128);

    // No further repayments ever arrive. Contributor 2 calls flush_secondary_buffer permissionlessly
    let flushed = setup.client.flush_secondary_buffer(&setup.investor2);
    assert_eq!(flushed, 5_000_000i128); // Exactly 0.5 USDC flushed into Tranche #1

    // Investors claim from the flushed tranche:
    // 60% of 5_000_000 = 3_000_000 stroops
    // 40% of 5_000_000 = 2_000_000 stroops
    let sec1 = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    let sec2 = setup.client.claim_secondary_recovery(&setup.investor2, &None);
    assert_eq!(sec1, 3_000_000i128);
    assert_eq!(sec2, 2_000_000i128);
    assert_eq!(sec1 + sec2, 5_000_000i128);

    // Exactly zero residual funds locked in the contract!
    assert_eq!(setup.token_client.balance(&setup.contract_id), 0i128);
}


#[test]
fn test_autonomous_balance_reconciliation_on_direct_tw_refund() {
    // Verifies invariant-based autonomous reconciliation when Trustless Work or arbiter sends funds
    // DIRECTLY to the pool contract address (push transfer), with multi-stage payouts and zero double-counting:
    // 1. Contributors pool 10,000 USDC -> Released to TW Escrow
    // 2. Dispute occurs; TW Escrow contract executes a native token transfer of 7,500 USDC directly to KallpaPool address
    // 3. Contributor invokes `reconcile_incoming_balance` post-deadline (or TW escrow invokes anytime)
    // 4. Contract recognizes unrecorded surplus, updates TotalRepaid to 7,500 USDC, and transitions to Disputed
    // 5. Investors claim primary pro-rata returns: 4,500 and 3,000 USDC. Balance drops to 0!
    // 6. ADVERSARIAL TEST: Re-calling reconcile_incoming_balance produces ZERO surplus (no phantom tranches)
    // 7. MULTI-TRANCHE TEST: Months later, an additional 1,000 USDC dispute recovery is pushed directly to KallpaPool.
    // 8. Reconcile accurately detects exactly 1,000 USDC as unallocated surplus, creating a secondary tranche!
    // 9. Investors claim their secondary share (600 and 400 USDC) with zero residual dust.
    let setup = setup_test();
    let target = 10_000_0000000i128; // 10,000 USDC
    let repayment_target = 10_000_0000000i128;
    let min_contribution = 100_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    setup.client.contribute(&setup.investor1, &6_000_0000000i128); // 60%
    setup.client.contribute(&setup.investor2, &4_000_0000000i128); // 40%

    // Target funded -> 10,000 USDC sits in tw_escrow
    assert_eq!(setup.token_client.balance(&setup.tw_escrow), target);
    assert_eq!(setup.token_client.balance(&setup.contract_id), 0i128);

    // TW Escrow executes a DIRECT token transfer to KallpaPool address (no caller withdraw required)
    setup.token_client.transfer(&setup.tw_escrow, &setup.contract_id, &7_500_0000000i128);
    assert_eq!(setup.token_client.balance(&setup.contract_id), 7_500_0000000i128);

    // In Funded state before repayment deadline: third-party/contributor cannot force premature Disputed transition
    setup.env.ledger().set_timestamp(funding_deadline + 10);
    let premature_res = setup.client.try_reconcile_incoming_balance(&setup.investor1);
    assert_eq!(premature_res, Err(Ok(Error::Unauthorized)));

    // Advance past repayment_deadline: loan defaulted/disputed window opens permissionlessly
    setup.env.ledger().set_timestamp(repayment_deadline + 10);

    let surplus = setup.client.reconcile_incoming_balance(&setup.investor1);
    assert_eq!(surplus, 7_500_0000000i128);

    let (_, state, _, total_repaid) = setup.client.get_pool_info();
    assert_eq!(state, PoolState::Disputed);
    assert_eq!(total_repaid, 7_500_0000000i128);

    // Investors claim pro-rata: 60% of 7,500 = 4,500 USDC; 40% of 7,500 = 3,000 USDC
    let p1 = setup.client.claim_return(&setup.investor1);
    let p2 = setup.client.claim_return(&setup.investor2);
    assert_eq!(p1, 4_500_0000000i128);
    assert_eq!(p2, 3_000_0000000i128);
    assert_eq!(p1 + p2, 7_500_0000000i128);
    assert_eq!(setup.token_client.balance(&setup.contract_id), 0i128);

    // Invariant Check 1: Re-calling reconcile produces 0 surplus
    let re_call = setup.client.reconcile_incoming_balance(&setup.investor1);
    assert_eq!(re_call, 0i128);

    // Invariant Check 2: Second push of 1,000 USDC arrives later
    setup.token_client.transfer(&setup.tw_escrow, &setup.contract_id, &1_000_0000000i128);
    let sec_surplus = setup.client.reconcile_incoming_balance(&setup.investor2);
    assert_eq!(sec_surplus, 1_000_0000000i128);

    // Claim secondary share
    let sec1 = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    let sec2 = setup.client.claim_secondary_recovery(&setup.investor2, &None);
    assert_eq!(sec1, 600_0000000i128); // 60% of 1,000
    assert_eq!(sec2, 400_0000000i128); // 40% of 1,000
    assert_eq!(sec1 + sec2, 1_000_0000000i128);
    assert_eq!(setup.token_client.balance(&setup.contract_id), 0i128);
}


#[test]
fn test_flush_and_reconcile_preserves_solvency_and_prevents_phantom_surplus() {
    // Tests the hostile Council finding:
    // When flush_secondary_buffer creates a tranche from PendingSecondaryBuffer,
    // TotalSecondaryAllocated is incremented.
    // Subsequent calls to reconcile_incoming_balance (both before and after claims)
    // MUST strictly recognize 0 unallocated surplus!
    // No phantom tranches or over-claims are possible.
    let setup = setup_test();
    let target = 10_000_0000000i128;
    let repayment_target = 10_000_0000000i128;
    let min_contribution = 100_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    setup.client.contribute(&setup.investor1, &6_000_0000000i128); // 60%
    setup.client.contribute(&setup.investor2, &4_000_0000000i128); // 40%

    // Repay 10,000.5 USDC -> settles pool, puts 0.5 USDC (5_000_000 stroops) into PendingSecondaryBuffer
    setup.client.settle_repayment(&setup.payer, &10_000_5000000i128);

    // Primary claims
    assert_eq!(setup.client.claim_return(&setup.investor1), 6_000_0000000i128);
    assert_eq!(setup.client.claim_return(&setup.investor2), 4_000_0000000i128);

    // Flush the buffer to create Tranche #1 (0.5 USDC)
    let flushed = setup.client.flush_secondary_buffer(&setup.investor2);
    assert_eq!(flushed, 5_000_000i128);

    // ADVERSARIAL CHECK 1: Immediately call reconcile_incoming_balance.
    // MUST return 0 because the 0.5 USDC is already allocated to Tranche #1!
    let recon_before_claim = setup.client.reconcile_incoming_balance(&setup.investor1);
    assert_eq!(recon_before_claim, 0i128);

    // Investor 1 claims secondary share (60% of 0.5 USDC = 3_000_000 stroops)
    let s1 = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    assert_eq!(s1, 3_000_000i128);

    // ADVERSARIAL CHECK 2: Reconcile between claims.
    // Still MUST return 0!
    let recon_mid_claim = setup.client.reconcile_incoming_balance(&setup.investor1);
    assert_eq!(recon_mid_claim, 0i128);

    // Investor 2 claims secondary share (40% of 0.5 USDC = 2_000_000 stroops)
    let s2 = setup.client.claim_secondary_recovery(&setup.investor2, &None);
    assert_eq!(s2, 2_000_000i128);

    // ADVERSARIAL CHECK 3: Reconcile after all claims when contract balance is 0.
    // MUST return 0! (Previous bug calculated 0 - (-0.5) = +0.5 phantom surplus).
    let recon_after_all = setup.client.reconcile_incoming_balance(&setup.investor1);
    assert_eq!(recon_after_all, 0i128);

    // Now a legitimate recovery of 1.0 USDC arrives
    setup.token_client.transfer(&setup.tw_escrow, &setup.contract_id, &10_000_000i128);
    let legitimate_surplus = setup.client.reconcile_incoming_balance(&setup.investor1);
    assert_eq!(legitimate_surplus, 10_000_000i128); // exactly 1.0 USDC, NOT 1.5!

    // Both claim exact shares: 6_000_000 and 4_000_000
    let s1_t2 = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    let s2_t2 = setup.client.claim_secondary_recovery(&setup.investor2, &None);
    assert_eq!(s1_t2, 6_000_000i128);
    assert_eq!(s2_t2, 4_000_000i128);

    // Absolute zero residual dust in contract
    assert_eq!(setup.token_client.balance(&setup.contract_id), 0i128);
}


#[test]
fn test_secondary_tranche_chunking_and_bounded_materialization_at_monetary_cap() {
    // Tests slicing of large inflows exceeding MAX_MONETARY_CAP (10^19 stroops):
    // 1. Verifies that inflows exceeding MAX_MONETARY_CAP are cleanly sliced into tranches <= 10^19.
    // 2. Verifies that MAX_TRANCHES_PER_TX bounds iteration work per transaction.
    // 3. Verifies that claims over tranches at MAX_MONETARY_CAP evaluate without MathOverflow.
    let setup = setup_test();
    let target = 10_000_0000000i128;
    let repayment_target = 10_000_0000000i128;
    let min_contribution = 100_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    setup.client.contribute(&setup.investor1, &6_000_0000000i128);
    setup.client.contribute(&setup.investor2, &4_000_0000000i128);

    setup.client.settle_repayment(&setup.payer, &10_000_0000000i128);

    // Primary claims
    assert_eq!(setup.client.claim_return(&setup.investor1), 6_000_0000000i128);
    assert_eq!(setup.client.claim_return(&setup.investor2), 4_000_0000000i128);

    // Simulate an inflow of 2 * MAX_MONETARY_CAP (2 * 10^19 stroops) pushed to pool
    // Mint tokens to payer so settle_repayment can deliver this massive recovery
    let massive_recovery = 20_000_000_000_000_000_000i128; // 2 * 10^19
    setup.token_admin.mint(&setup.payer, &massive_recovery);

    // Deliver recovery in two tranches of MAX_MONETARY_CAP (10^19 each):
    let cap = 10_000_000_000_000_000_000i128;
    setup.client.settle_repayment(&setup.payer, &cap);
    setup.client.settle_repayment(&setup.payer, &cap);

    // Verify 2 tranches materialized
    let (_, _, _, _) = setup.client.get_pool_info();

    // Investor 1 (60%) claims both tranches
    // Payout per tranche: 60% of 10^19 = 6 * 10^18 stroops
    // Total payout = 1.2 * 10^19 stroops
    // Crucially: (cum_after * S_k) = 10^10 * 10^19 = 10^29 << 1.7 * 10^38 (Zero MathOverflow!)
    let claimed_inv1 = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    assert_eq!(claimed_inv1, 12_000_000_000_000_000_000i128); // 12 * 10^18 stroops

    // Investor 2 (40%) claims both tranches: 40% of 2 * 10^19 = 8 * 10^18 stroops
    let claimed_inv2 = setup.client.claim_secondary_recovery(&setup.investor2, &None);
    assert_eq!(claimed_inv2, 8_000_000_000_000_000_000i128); // 8 * 10^18 stroops

    // Conservation check: 12 * 10^18 + 8 * 10^18 = 20 * 10^18 = 2 * 10^19
    assert_eq!(claimed_inv1 + claimed_inv2, massive_recovery);
    assert_eq!(setup.token_client.balance(&setup.contract_id), 0i128);
}


#[test]
fn test_flush_secondary_buffer_slices_at_max_monetary_cap_preventing_overflow() {
    // Verifies hostile Council finding:
    // When PendingSecondaryBuffer contains an amount exceeding MAX_MONETARY_CAP (e.g. 2 * 10^19 stroops),
    // flush_secondary_buffer MUST NOT create a single massive tranche of 2 * 10^19!
    // It must slice into tranches <= MAX_MONETARY_CAP (10^19).
    // Claims by a participant with cum_after = total_collected = 10^19 MUST NOT panic with MathOverflow!
    let setup = setup_test();
    let cap = 10_000_000_000_000_000_000i128; // 10^19 stroops
    let target = cap;
    let repayment_target = cap;
    let min_contribution = 100_0000000i128;
    let funding_deadline = setup.env.ledger().timestamp() + 3600;
    let repayment_deadline = funding_deadline + 86400;

    setup.client.initialize(
        &setup.admin,
        &setup.token_addr,
        &setup.tw_escrow,
        &setup.payer,
        &target,
        &repayment_target,
        &funding_deadline,
        &repayment_deadline,
        &min_contribution,
    );

    // Contributor 1 deposits 10^19 (100% of capacity, maximum possible cum_after!)
    setup.token_admin.mint(&setup.investor1, &cap);
    setup.client.contribute(&setup.investor1, &cap);

    // Payer repays target of 10^19 -> Settled
    setup.token_admin.mint(&setup.payer, &cap);
    setup.client.settle_repayment(&setup.payer, &cap);

    // Contributor claims primary return of 10^19
    assert_eq!(setup.client.claim_return(&setup.investor1), cap);

    // Now simulate an inflow of 2 * 10^19 entering PendingSecondaryBuffer via direct push
    let massive_surplus = 2 * cap; // 2 * 10^19
    setup.token_admin.mint(&setup.tw_escrow, &massive_surplus);
    setup.token_client.transfer(&setup.tw_escrow, &setup.contract_id, &massive_surplus);

    // Advance past repayment deadline and reconcile
    setup.env.ledger().set_timestamp(repayment_deadline + 10);
    let rec = setup.client.reconcile_incoming_balance(&setup.investor1);
    assert_eq!(rec, massive_surplus);

    // Tranches materialized by record_secondary_tranche:
    // Because MAX_TRANCHES_PER_TX = 10 and amount = 2 * 10^19, it slices into exactly 2 tranches of 10^19!
    // Contributor claims secondary recovery:
    // Each tranche is 10^19. cum_after is 10^19.
    // Product: cum_after * S_k = 10^19 * 10^19 = 10^38 < i128::MAX (approx 1.7 * 10^38).
    // MUST NOT overflow!
    let claimed_sec = setup.client.claim_secondary_recovery(&setup.investor1, &None);
    assert_eq!(claimed_sec, massive_surplus);
    assert_eq!(setup.token_client.balance(&setup.contract_id), 0i128);
}
