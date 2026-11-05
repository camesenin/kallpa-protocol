# Soroban Operational Economics, Metering & Fee Architecture for Micro-Claims

This document details the exact economic mechanisms, transaction fee benchmarks, keeper architecture, and state restoration procedures designed for the **Kallpa Protocol** on Stellar Soroban (Protocol 23/28).

---

## 1. The Economic Micro-Claim Problem & The Multi-Layer Mitigation

In smart contract lending pools with fractional or dispute recovery, sub-dollar pro-rata entitlements can emerge:
- Example: An investor contributed $10.00 USDC to a $1,000.00 USDC pool.
- The borrower defaults; after non-cooperative dispute liquidation, a residual recovery of $1.00 USDC is recovered.
- The investor's mathematical pro-rata claim is:
  $$\text{Payout} = \frac{10}{1000} \times 1.00 = 0.01 \text{ USDC (1 cent)} = 100,000 \text{ stroops}$$

### The Soroban Resource Fee Barrier
A Soroban transaction invoking `claim_return` or `claim_secondary_recovery` incurs base resource metering:
- **Base Fee:** 100 stroops (0.00001 XLM).
- **Resource Fee (Inclusion, CPU, Memory, Storage Footprint Read/Write):** typically 0.005 to 0.025 XLM (~$0.0005 to $0.003 USD depending on XLM price).
- **If State Restoration is Required (Protocol 23):** restoring an archived persistent entry costs additional rent proportional to the entry byte-size and restoration period.

If an individual contributor must sign, submit, and pay fees to recover $0.01 USDC, the economic cost of gas and wallet signing friction causes **rational fund abandonment**.

---

## 2. Multi-Layer Solution Architecture

Kallpa implements a 4-tier structural mitigation:

### Tier 1: Upstream Pool Viability Guard & Minimum Ticket Sizing
- `min_contribution`: Invariant $min\_contribution \ge 1.0\text{ USDC}$ (default 10 USDC).
- Viability Guard: Every deposit must either fill the pool (`remaining_after == 0`) or leave at least `min_contribution` (`remaining_after >= min_contribution`).
- Prevents sub-minimum stranded pool capacity.

### Tier 2: Aggregated Recovery Tranching (`MIN_RECOVERY_TRANCHE`)
- Secondary and dispute recoveries are aggregated in an internal buffer until reaching $\ge 1.0\text{ USDC}$ (`MIN_RECOVERY_TRANCHE`), preventing fragmentation of the global state into thousands of micro-ledgers.
- Bounded batch claims (`max_tranches: Option<u32>`) process up to 50 tranches in a single contract invocation, amortizing resource fees across all tranches.

### Tier 3: Permissionless Disbursal Pattern (Zero Beneficiary Auth)
- `claim_return(investor)`, `refund(investor)`, and `claim_secondary_recovery(investor, max_tranches)` do NOT require caller authorization from `investor`.
- Transfer invariant: Tokens are immutably and strictly transferred to `&investor` (the position key owner), never to `env.invoker()` or any arbitrary address.
- **Result:** Any entity (a community keeper, protocol relayer, or DAO bot) can batch-execute and disburse claims to hundreds of users without requiring user signatures or private keys.

### Tier 4: Funded Community Keeper & Gas Sponsorship Specification
To ensure that micro-claims are never abandoned even if investors take no action, the protocol specifies the **Kallpa Keeper Subsidization Engine**:
1. **Operator:** Protocol Keeper Service (open-source daemon running against Soroban RPC).
2. **Dedicated Sponsor Account:** An on-chain fee-bump sponsor account funded with a permanent reserve (e.g. 100 XLM = ~10,000 subsidized claims).
3. **Execution Logic:**
   - The keeper queries open dispute pools via RPC `getContractData` for unsettled investor positions.
   - For positions where $0.001 < \text{payout} < \$1.00$, the keeper constructs the `InvokeHostFunctionOp` transaction with the sponsor paying transaction fees (`FeeBumpTransaction`).
   - If the sponsor reserve runs out, claims remain fully preserved and intact on-chain: investors can claim at any time in the future, or third-party community bots can resume disbursals.

---

## 3. Protocol 23 State Archival & Auto-Restoration Economics

### Exact Ledger Lifetimes
- **Instance Storage (`DataKey::Config`, `State`, `TotalCollected`, etc.):**
  - Threshold: 120,960 ledgers (~7 days).
  - Bump Amount: 518,400 ledgers (~30 days).
- **Persistent Storage (`DataKey::Position(Address)`, `SecondaryTranche(u32)`):**
  - Threshold: 241,920 ledgers (~14 days).
  - Bump Amount: 1,036,800 ledgers (~60 days).

### Restoration Flow (CAP-0066 & Protocol 23)
1. **Simulation via Soroban RPC:** Calling `simulateTransaction` on an archived position returns a transaction footprint containing the archived keys in the `readWrite` footprint with `restoreReservation`.
2. **Automatic Restoration:** Under Stellar Protocol 23, when an archived entry is included in the simulation footprint, `InvokeHostFunctionOp` automatically restores the entry within the same atomic execution, charging the designated rent fee from the transaction sponsor.
3. **Fallback Manual Restoration:** If transaction resource limits prevent combined invocation and restoration, a standalone `RestoreFootprintOp` is submitted beforehand to restore entries to live state prior to invoking `claim_return`.
