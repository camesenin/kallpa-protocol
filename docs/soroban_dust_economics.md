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

### Tier 4: Autonomous Keeper Daemon & Per-Transaction Budgeting Engine
To eliminate user friction, the **Autonomous Keeper Daemon** (`@kallpa/keeper`) operates continuously:
1. **Operator:** Open-source TypeScript daemon operating against standard Soroban RPC.
2. **Canonical Solvency Verification:**
   - Computes available balance using canonical Stellar Core reserve math:
     $$\text{available} = \text{balance} - ((2 + \text{numSubEntries} + \text{numSponsoring} - \text{numSponsored}) \times \text{baseReserve} + \text{sellingLiabilities})$$
3. **Per-Transaction Budget Checking:**
   - Prior to EVERY dispatch (restoration or invocation), the daemon queries the sponsor's current available balance and verifies that:
     $$\text{currentAvailable} - \text{operationFee} \ge \text{minSponsorReserveStroops}$$
   - Preserves the sponsor's reserve cushion under all execution conditions.
4. **Economic Subsidization Model:**
   - A dedicated 100 XLM sponsor reserve provides:
     * At ~0.02 XLM per subsidized claim: **5,000 automated claims**.
     * At ~0.048 XLM (worst-case 50 tranches): **2,080 automated claims**.
   - If the sponsor reserve runs out, claims remain fully preserved and intact on-chain: investors can claim at any time in the future, or third-party community bots can resume disbursals.

---

## 3. Protocol 23 & CAP-0066 State Archival & Auto-Restoration Economics

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
