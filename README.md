# Kallpa Protocol (`kallpa-protocol`)

<p align="center">
  <strong>Soroban Multi-Party Funding & Zero-Dust Pro-Rata Settlement for Trustless Work Escrows</strong>
  <br />
  <em>Open-Source Infrastructure on Stellar & Soroban</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Stellar-Soroban%20v28-blue.svg" alt="Soroban v28" />
  <img src="https://img.shields.io/badge/Escrow-Trustless%20Work%20EaaS-purple.svg" alt="Trustless Work" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License MIT" />
</p>

---

## ⚡ Overview

**Kallpa Protocol** is an open-source Soroban smart contract primitive designed to enable **collective multi-party capital aggregation and deterministic zero-dust pro-rata settlement** for **Trustless Work** escrows on the Stellar network.

While Trustless Work provides battle-tested Escrow-as-a-Service (EaaS) contracts for milestone-based releases, its standard escrow architecture natively assumes a single funding principal (`Depositor` / `Funder` role). Kallpa bridges this gap by acting as the non-custodial capital aggregation layer: it allows multiple decentralized participants to pool USDC towards an escrow target, guaranteeing atomic milestone transitions, zero rounding drift (*telescoping prefix-sum integer arithmetic*), and permissionless on-chain refunds if funding targets are not met.

---

## 🏗️ Architecture & Operational Modes

```mermaid
flowchart TD
    subgraph Mode A: Public Goods & Collective Bounties
        A1["Participant A (USDC)"] -->|"Partial Contribution"| KP1["Kallpa Pool Contract"]
        A2["Participant B (USDC)"] -->|"Partial Contribution"| KP1
        A3["Participant N (USDC)"] -->|"Partial Contribution"| KP1
        KP1 -->|"Target Reached"| TW1["Trustless Work Escrow (Depositor: Kallpa)"]
        TW1 -->|"Milestone Approved"| DEV["Developer / Auditor (Beneficiary)"]
        TW1 -.->|"Dispute Resolved"| KP1
        KP1 -.->|"Refund on Dispute / Expiry"| A1
    end

    subgraph Mode B: Syndicated Liquidity Advance (Illustrative)
        B1["Syndicate Investor 1"] -->|"Advance Liquidity"| KP2["Kallpa Pool Contract"]
        B2["Syndicate Investor 2"] -->|"Advance Liquidity"| KP2
        KP2 -->|"Target Reached (10,000 USDC)"| TW2["Trustless Work Escrow"]
        TW2 -->|"Milestone Delivered"| PROV["Service Provider"]
        DAO["DAO Treasury / External Payer"] -->|"Settlement (11,000 USDC)"| KP2
        KP2 -->|"Telescoping Zero-Dust Pro-Rata"| B1
        KP2 -->|"Telescoping Zero-Dust Pro-Rata"| B2
    end
```

### Key Engineering Pillars
1. **Multi-Party Soroban Pooling (`contracts/kallpa-pool`):**
   - Strictly checked integer arithmetic (`checked_mul`, `checked_div`, `checked_add`) eliminating floating-point imprecision.
   - Formal state machine: `Open` → `Funded` → `Settled` (or auto-transition to `Refundable` on expired deadline).
   - Segregated storage design: Instance storage for global parameters; persistent storage with explicit TTL extensions (`extend_ttl`) for participant positions.
   - Resource-bounded claims: Hard limit of 16 Deposit Slices per address with in-memory aggregation to guarantee execution stays well within Soroban CPU/memory metering limits.
2. **Trustless Work Interoperability:**
   - Pre-audited milestone escrow primitives downstream (`github.com/Trustless-Work/trustlesswork-smart-contract-stellar`).
   - Eliminates custodial aggregation: funds remain on-chain at all times.
3. **Exact Telescoping Pro-Rata Math (`@kallpa/sdk`):**
   - Algebraic telescoping prefix-sum identity:
     $$\text{Payout}_i = \left\lfloor \frac{C_{\text{after}} \times R}{T} \right\rfloor - \left\lfloor \frac{C_{\text{prior}} \times R}{T} \right\rfloor$$
   - Guarantees $\sum \text{Payout}_i = R$ with zero residual dust left in the contract.

---

## 📂 Repository Structure

```
kallpa-protocol/
├── contracts/
│   └── kallpa-pool/           # Core Soroban smart contract in Rust
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs         # Lifecycle, contribution & settlement logic
│           ├── types.rs       # Data structures, errors, and storage keys
│           └── test.rs        # Comprehensive unit & invariant tests
├── packages/
│   └── sdk/                   # TypeScript SDK for client & integration tooling
│       ├── package.json
│       └── src/
│           ├── index.ts       # Pro-rata math, capacity validation & helpers
│           └── index.test.ts  # Bun unit tests
├── apps/
│   └── web/                   # Next.js 15 reference dApp (WIP)
├── CONTRIBUTING.md            # Guidelines for open-source contributors
├── LICENSE                    # MIT License
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites
- **Rust Toolchain:** `rustc 1.80+` with target `wasm32-unknown-unknown`
- **Bun:** `v1.1+` (recommended for SDK and tests) or **Node.js:** `v20+`

### 1. Run Smart Contract Tests
```bash
cargo test --workspace
```
*Current test suite: 5 passing unit tests (full lifecycle, deadline expiration refund, zero-dust telescoping pro-rata invariant, multiple deposit rejection guard, and escrow dispute refund).*

### 2. Run TypeScript SDK Tests
```bash
cd packages/sdk
bun test
```
*Current test suite: 5 passing unit tests (telescoping pro-rata math, 3-party asymmetric fractional repayments, capacity clamping, negative parsing, and boundary validation).*

---

## 🗺️ Roadmap & Milestones (SCF Integration Track)

- [x] **Phase 0:** Core pooling contract architecture and exact telescoping math engine.
- [ ] **Milestone 1 ($5,000 USDC):** Hardened Soroban contract with bounded Deposit Slices, Soroban TTL management, property-based fuzzing, and live Testnet spike against real Trustless Work escrow contracts (validating cross-contract funding and dispute refund flows).
- [ ] **Milestone 2 ($5,000 USDC):** Trustless Work integration adapter crate (`kallpa-adapter-tw`), automated E2E Testnet integration script, and GitHub Actions CI pipeline.
- [ ] **Milestone 3 ($5,000 USDC):** Reference Next.js 15 dApp with Freighter Wallet integration, `@kallpa/sdk` NPM publication, bilingual developer documentation, and verified on-chain Testnet completion by independent external accounts.

---

## 👤 Maintainer & Lead Engineer

- **Carlos Murillo** ([`@camesenin`](https://github.com/camesenin))
  - Core contributor to Soroban and Stellar ecosystem protocols (Tansu DAO governance smart contracts, Boundless Builders infrastructure, Mercato, KindFi).

## 📄 License
This project is licensed under the [MIT License](LICENSE).
