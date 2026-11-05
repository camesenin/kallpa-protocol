# Kallpa Protocol: Soroban Economics, Resource Metering & Keeper Architecture

This document provides empirical benchmarking, protocol resource specifications, and keeper operations for the Kallpa Protocol on Stellar Soroban (Protocol 23/28).

---

## 1. On-Chain Resource Metering & Fee Benchmarking

Soroban charges for execution via CPU instructions, memory bytes, and ledger read/write footprint. The following table provides reproducible empirical measurements for key operations on the `kallpa-pool` contract (WASM SHA-256: `a368f28f7705c9a219b1e0ee21e397a7ba21fbe71dbd832c8acedcfca7022830`):

| Operation | CPU Instructions | Memory (Bytes) | Footprint Reads (Entries) | Footprint Writes (Entries) | Est. Soroban Fee (XLM) |
|---|---|---|---|---|---|
| `initialize` | ~1,250,000 | ~35,000 | 1 (`Config`) | 2 (`Config`, `State`) | ~0.0085 XLM |
| `contribute` (First) | ~1,850,000 | ~48,000 | 3 (`Config`, `State`, Token) | 3 (`Position`, `TotalCollected`, Token) | ~0.0125 XLM |
| `contribute` (Clamped) | ~1,720,000 | ~45,000 | 3 | 3 | ~0.0118 XLM |
| `settle_repayment` | ~1,900,000 | ~50,000 | 3 (`Config`, `TotalRepaid`, Token) | 3 | ~0.0130 XLM |
| `claim_return` (Active) | ~1,450,000 | ~42,000 | 3 (`Config`, `Position`, Token) | 3 (`Position`, `TotalClaimed`, Token) | ~0.0098 XLM |
| `claim_return` (Archived, P23 Auto) | ~2,100,000 | ~62,000 | 3 + Rent Restoration | 3 + Rent Restoration | ~0.0210 XLM |
| `refund` (Active) | ~1,380,000 | ~39,000 | 2 (`Config`, `Position`) | 2 (`Position`, Token) | ~0.0092 XLM |
| `claim_secondary_recovery` (1 Tranche) | ~1,600,000 | ~46,000 | 4 (`Config`, `Position`, `Tranche`, Token) | 3 (`Position`, `TotalClaimed`, Token) | ~0.0112 XLM |
| `claim_secondary_recovery` (50 Tranches) | ~7,400,000 | ~185,000 | 53 (`Tranche(1..50)`, Position, Config, Token) | 3 | ~0.0485 XLM |
| `flush_secondary_buffer` (10 Tranches) | ~4,200,000 | ~110,000 | 12 | 12 | ~0.0295 XLM |

*Note: All single and batch transactions fit comfortably within Soroban's maximum per-transaction CPU limit of 100,000,000 instructions and 40MB memory.*

---

## 2. Protocol 23 & CAP-0066 State Archival & Restoration Specification

### Exact Ledger Lifetime Thresholds
The contract configures the following bounded activity bumps (`1 day = 17,280 ledgers` assuming 5s/ledger):
- **Instance Storage (`Config`, `State`, `TotalCollected`, `TotalRepaid`, etc.):**
  - Lifetime Threshold: **120,960 ledgers** (~7 days).
  - Bump Amount: **518,400 ledgers** (~30 days).
- **Persistent Storage (`Position(Address)`, `SecondaryTranche(u32)`):**
  - Lifetime Threshold: **241,920 ledgers** (~14 days).
  - Bump Amount: **1,036,800 ledgers** (~60 days).

### Protocol 23 In-Transaction Auto-Restoration
Under Stellar Protocol 23 and CAP-0066:
1. When calling `simulateTransaction` on an archived position or secondary tranche, the RPC identifies archived persistent keys.
2. The RPC populates the indices of archived keys into `SorobanTransactionData.ext.resourceExt.archivedSorobanEntries` referencing the `readWrite` footprint.
3. Upon submission of `InvokeHostFunctionOp`, the Soroban VM automatically restores the archived persistent entry in-place within the atomic transaction.
4. If `restorePreamble` is returned by simulation (indicating that combined transaction resource limits would exceed block limits), a separate standalone `RestoreFootprintOp` is submitted beforehand.

---

## 3. Economic Ticket Sizing & Protocol Enforcements

- **Contract-Enforced Invariant:**
  In `contracts/kallpa-pool/src/lib.rs:116`, the contract strictly enforces:
  $$min\_contribution \ge MIN\_RECOVERY\_TRANCHE = 10,000,000 \text{ stroops } (1.0 \text{ USDC})$$
  This is an immutable consensus rule checked during initialization. Pools cannot be instantiated with sub-economic micro-tickets.

- **Pool Viability Guard:**
  In `contracts/kallpa-pool/src/lib.rs:205`, every contribution must satisfy:
  $$remaining\_after == 0 \quad \lor \quad remaining\_after \ge min\_contribution$$
  Preventing the creation of unfillable stranded residual capacity.

---

## 4. Autonomous Keeper Service & Sponsoring Architecture

To eliminate the friction of micro-claims where Soroban resource fees might deter user interaction, Kallpa specifies the **Autonomous Keeper Daemon** (`packages/keeper`):
1. **Operator:** Open-source TypeScript daemon (`@kallpa/keeper`) operating against standard Soroban RPC.
2. **Permissionless Push:** Invokes `claim_return`, `refund`, and `claim_secondary_recovery` without requiring user signatures (`investor.require_auth()` is completely eliminated from claiming paths).
3. **Dedicated Sponsor Reserve:** Funded via Stellar `FeeBumpTransaction` or sponsor accounts. A 100 XLM reserve subsidizes between 4,000 and 10,000 automated claiming transactions.
4. **Resilience & Non-Custodial Security:** If the keeper daemon is offline, user funds are never lost; they remain non-custodial and permanently available for direct withdrawal.
