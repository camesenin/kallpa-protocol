# Contributing to Kallpa Finance

We welcome contributions to **Kallpa Finance**! This document provides guidelines for contributors.

## Code Standards
- **Smart Contracts (Rust):**
  - Follow the official [Soroban Rust guidelines](https://soroban.stellar.org).
  - All financial math must use checked arithmetic (`checked_add`, `checked_sub`, `checked_mul`, `checked_div`).
  - Pass all tests via `cargo test`.
  - Maintain clean, warning-free code.
- **Client & Tooling (TypeScript / Bun):**
  - Use Bun for package management and testing.
  - Run `bun test` in `packages/sdk` before submitting a pull request.
  - Adhere to strict TypeScript typing (no loose `any`).

## Development Workflow
1. Fork the repository and create your branch from `develop`.
2. Ensure all unit and integration tests pass locally.
3. Commit your changes with descriptive, conventional commit messages:
   - `feat(pool): ...`
   - `fix(escrow): ...`
   - `test(sdk): ...`
4. Open a Pull Request targeting `develop`.
