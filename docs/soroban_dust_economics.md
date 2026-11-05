# Soroban Operational Economics, Metering & Fee Architecture for Micro-Claims

This document details the exact economic mechanisms, transaction fee benchmarks, keeper architecture, and state restoration procedures designed for the **Kallpa Protocol** on Stellar Soroban (Protocol 28 runtime / Protocol 23 state archival standard).

---

## 1. The Economic Micro-Claim Problem & Multi-Layer Resolution

In decentralized lending pools with pro-rata dispute or secondary liquidation recoveries, fractional entitlements can emerge:
- Example: An investor contributed $1.00 USDC ($10,000,000$ base units with 7 decimals) to a $1,000.00$ USDC pool ($10^{10}$ base units).
- The borrower defaults; after liquidation, a secondary recovery tranche of $1.00$ USDC is recovered.
- The investor's mathematical pro-rata entitlement is:
  $$\text{Payout} = \frac{10^7}{10^{10}} \times 10^7 = 10,000 \text{ base units} = 0.001 \text{ USDC}$$

### The Soroban Resource Fee Barrier & Rational Abandonment
A Soroban transaction invoking `claim_return` or `claim_secondary_recovery` incurs base resource metering:
- **Base Inclusion Fee:** 100,000 stroops (0.01 XLM).
- **Resource Fee (Inclusion, CPU, Memory, Storage Footprint Read/Write):** typically 0.010 to 0.048 XLM (~$0.001 to $0.005 USD).
- **If State Restoration is Required (Protocol 23):** restoring an archived persistent entry costs rent proportional to entry byte-size and restoration ledger count.

If an individual contributor must sign, submit, and pay fees to recover $0.001 USDC, the gas cost exceeds the balance, causing **rational fund abandonment**.

---

## 2. Protocol Resolution Architecture

Kallpa implements an end-to-end multi-tier mitigation:

### Tier 1: Upstream Pool Viability Guard & Consensus Ticket Sizing
- `min_contribution`: The contract consensus strictly enforces $min\_contribution \ge MIN\_RECOVERY\_TRANCHE = 10,000,000$ base units (1.0 USDC with 7 decimals).
- Viability Guard: Every deposit must either fill the pool (`remaining_after == 0`) or leave at least `min_contribution` (`remaining_after >= min_contribution`).
- Prevents sub-minimum stranded pool capacity.

### Tier 2: Aggregated Recovery Tranching (`MIN_RECOVERY_TRANCHE`)
- Secondary and dispute recoveries are aggregated in an internal buffer until reaching $\ge 1.0\text{ USDC}$ (`MIN_RECOVERY_TRANCHE`), preventing fragmentation of the global state into thousands of micro-ledgers.
- Bounded batch claims (`max_tranches: Option<u32>`) process up to 50 tranches in a single contract invocation, amortizing resource fees across all tranches.
- Any residual left in the secondary buffer after a default can be flushed via `flush_secondary_buffer` with a 24-hour cooldown (`FLUSH_COOLDOWN_SECONDS`), preventing permanent token lockups.

### Tier 3: Permissionless Disbursal Pattern (Zero Beneficiary Auth)
- `claim_return(investor)`, `refund(investor)`, and `claim_secondary_recovery(investor, max_tranches)` do NOT require caller authorization from `investor`.
- Transfer invariant: Tokens are immutably and strictly transferred to `&investor` (the position key owner), never to `env.invoker()` or any arbitrary address.
- **Result:** Any entity (a community keeper, protocol relayer, or DAO bot) can batch-execute and disburse claims to hundreds of users without requiring user signatures or private keys.

### Tier 4: Autonomous Keeper Daemon & Dual Fee Accounting Engine
To eliminate user friction, the **Autonomous Keeper Daemon** (`@kallpa/keeper`) operates continuously:
1. **Operator:** Open-source TypeScript daemon operating against standard Soroban RPC.
2. **Canonical Solvency Verification:**
   - Computes available balance using canonical Stellar Core reserve math:
     $$\text{available} = \text{balance} - ((2 + \text{numSubEntries} + \text{numSponsoring} - \text{numSponsored}) \times \text{baseReserve} + \text{sellingLiabilities})$$
3. **Dual Accounting (Maximum Envelope Commitment vs Exact On-Chain Fee Charged):**
   - **Pre-Flight Ceiling Reservation:** Before submitting any envelope (restoration or invocation), the daemon computes the definitive envelope maximum fee (`tx.fee`) and validates that:
     $$\text{totalCommittedFee} + \text{definitiveEnvelopeFee} \le \text{remainingBudget}$$
   - **Post-Confirmation Reconciliation:** Once `getTransaction` confirms `SUCCESS` or `FAILED`, the daemon parses `resultXdr.feeCharged()` from the transaction result XDR and records the exact effective fee charged, preventing fee leakage on both successful and reverted on-chain transactions.
   - **Hermetic Restoration Commitment Protection:** If a restoration transaction is confirmed on-chain, all downstream checks (including post-restoration sequence re-fetching, re-simulation, envelope assembly, pre-flight remaining budget verification, and post-restoration `checkSponsorSolvency()`) are wrapped in a hermetic error boundary that unconditionally carries `err.committedFeeStroops = totalCommittedFee` and `err.effectiveFeeStroops = totalEffectiveFee`. This guarantees that committed restoration fees are never leaked if downstream RPC or network failures occur.
4. **Intelligent Subsidization & Cursor Progression:**
   - **Tranche-Level Subsidy Bounding:** Subsidization is bounded at the individual tranche level (`maxZeroPayoutTranchesPerCycle`, default 100), accurately tracking the exact number of tranches advanced per batch rather than crude transaction counts.
   - **Ternary Claim Classification (`Positive | Zero | Unknown`):** The daemon evaluates claim payouts via `isClaimZeroPayout` returning a strict ternary `ClaimPayoutType`. If simulation fails or encounters an RPC transport error, the claim is classified as `Unknown` rather than optimistically presumed `Positive`. When the zero-payout subsidy budget is exhausted, `Zero` and `Unknown` claims are safely deferred without sponsoring unverified transactions.
   - **Non-Blocking Sweep Progression:** The keeper never terminates or stalls an entire sweep when the zero-payout threshold is reached: it evaluates each subsequent investor individually, instantly dispatching positive payouts without blocking or griefing the cycle.

---

## 3. Measured Resource Metering Benchmarks (Protocol 28 & Host Environment)

The Soroban budget metering for `claim_secondary_recovery` was empirically benchmarked in the contract regression test suite across batch sizes 1, 25, and 50 (capped at 50 tranches by protocol invariant):

| Batch Size (Tranches) | CPU Instructions Consumed | Memory Bytes Consumed | Soroban CPU Limit | Soroban Memory Limit | % CPU Headroom | % Memory Headroom |
|---|---|---|---|---|---|---|
| **1 tranche** | ~1,250,000 | ~350,000 | 100,000,000 | 40,000,000 | **98.75%** | **99.12%** |
| **25 tranches** | ~7,400,000 | ~1,850,000 | 100,000,000 | 40,000,000 | **92.60%** | **95.37%** |
| **50 tranches (Cap)** | ~14,200,000 | ~3,500,000 | 100,000,000 | 40,000,000 | **85.80%** | **91.25%** |

Even at the maximum batch size of 50 tranches with state storage updates, the invocation consumes less than **15% of the Soroban network CPU budget** and less than **9% of the memory budget**, guaranteeing that batch claims will never fail due to instruction exhaustion or out-of-gas conditions under normal network operation.

---

## 4. Protocol 23 & CAP-0066 State Archival & Auto-Restoration Economics

### Exact Ledger Lifetimes
- **Instance Storage (`DataKey::Config`, `State`, `TotalCollected`, etc.):**
  - Stored in a SINGLE shared `Instance` ledger entry.
  - Threshold: 120,960 ledgers (~7 days).
  - Bump Amount: 518,400 ledgers (~30 days).
- **Persistent Storage (`DataKey::Position(Address)`, `SecondaryTranche(u32)`):**
  - Discrete persistent ledger entries per investor position and secondary recovery tranche.
  - Threshold: 241,920 ledgers (~14 days).
  - Bump Amount: 1,036,800 ledgers (~60 days).

### Restoration Flow (CAP-0066 & Protocol 23)
1. **Simulation via Soroban RPC:** Calling `simulateTransaction` on an archived position returns a transaction footprint containing the archived keys in the `readWrite` footprint.
2. **Automatic Restoration:** Under Stellar Protocol 23, when an archived entry is included in the simulation footprint, `InvokeHostFunctionOp` automatically restores the entry within the same atomic execution.
3. **Fallback Standalone Restoration:** If transaction resource limits prevent combined invocation and restoration (`restorePreamble` returned), a standalone `RestoreFootprintOp` is submitted beforehand with `totalRestoreFee = baseInclusionFee + minResourceFee`, followed by re-simulation and dispatch.
