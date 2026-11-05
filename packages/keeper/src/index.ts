/**
 * Kallpa Protocol - Autonomous Keeper Service Daemon
 *
 * Implements full coverage of claim_return, refund, and claim_secondary_recovery,
 * real position processing, sponsor balance tracking, Protocol 23 restoration fallback,
 * and robust confirmation handling.
 */

import {
  rpc,
  TransactionBuilder,
  Keypair,
  Contract,
  Operation,
  Address,
  xdr,
} from "@stellar/stellar-sdk";

export interface KeeperConfig {
  rpcUrl: string;
  networkPassphrase: string;
  sponsorSecret: string;
  poolContractIds: string[];
  maxTranchesPerBatch: number;
  minSponsorReserveStroops: bigint; // e.g. 50_000_000n (5 XLM safety threshold in stroops)
}

export interface InvestorClaimTarget {
  investor: string;
  action: "claim_return" | "refund" | "claim_secondary";
  maxTranches?: number;
}

export class KallpaKeeperDaemon {
  private server: rpc.Server;
  private sponsorKey: Keypair;
  private config: KeeperConfig;

  constructor(config: KeeperConfig) {
    this.config = config;
    this.server = new rpc.Server(config.rpcUrl);
    this.sponsorKey = Keypair.fromSecret(config.sponsorSecret);
  }

  /**
   * Check sponsor XLM available balance using on-chain ledger entries via RPC getLedgerEntries.
   * Passes accountKey as a direct parameter (rest parameter syntax in SDK v14) and accesses entry.val.
   * Calculates available balance by subtracting minimum reserve from total balance.
   */
  async checkSponsorSolvency(): Promise<{ solvent: boolean; balanceStroops: bigint; availableStroops: bigint }> {
    try {
      const accountId = this.sponsorKey.xdrAccountId();
      const accountKey = xdr.LedgerKey.account(
        new xdr.LedgerKeyAccount({ accountId })
      );

      // In SDK v14 getLedgerEntries accepts keys as separate arguments (...keys)
      const res = await this.server.getLedgerEntries(accountKey);
      if (res.entries && res.entries.length > 0) {
        const entry = res.entries[0];
        // entry.val contains the parsed xdr.LedgerEntryData
        const accountEntry = entry.val.account();
        const totalBalance = accountEntry.balance().toBigInt();
        const subentryCount = BigInt(accountEntry.numSubentries());
        // Standard Stellar reserve math: base reserve = 0.5 XLM (5_000_000 stroops)
        // Min reserve = (2 + numSubentries) * baseReserve
        const minReserve = (2n + subentryCount) * 5_000_000n;
        const available = totalBalance > minReserve ? totalBalance - minReserve : 0n;

        return {
          solvent: available >= this.config.minSponsorReserveStroops,
          balanceStroops: totalBalance,
          availableStroops: available,
        };
      }
    } catch (e) {
      console.warn("Could not query on-chain account entry, falling back:", e);
    }

    return {
      solvent: this.config.minSponsorReserveStroops === 0n,
      balanceStroops: 0n,
      availableStroops: 0n,
    };
  }

  /**
   * Monitor registered pools and disburse pending claims permissionlessly
   * across all three protocol claiming routes.
   */
  async runSweepCycle(
    targetsByPool: Map<string, InvestorClaimTarget[]>
  ): Promise<{ processed: number; errors: number; skippedForLowFunds: boolean }> {
    let processed = 0;
    let errors = 0;

    const solvency = await this.checkSponsorSolvency();
    if (!solvency.solvent) {
      console.warn(`Sponsor reserve low (${solvency.availableStroops} available stroops < ${this.config.minSponsorReserveStroops} stroops). Pausing sweep.`);
      return { processed: 0, errors: 0, skippedForLowFunds: true };
    }

    for (const poolId of this.config.poolContractIds) {
      const targets = targetsByPool.get(poolId) || [];
      const poolContract = new Contract(poolId);

      for (const target of targets) {
        try {
          if (target.action === "claim_return") {
            await this.disburseClaimReturn(poolContract, target.investor);
          } else if (target.action === "refund") {
            await this.disburseRefund(poolContract, target.investor);
          } else if (target.action === "claim_secondary") {
            await this.disburseSecondaryRecovery(
              poolContract,
              target.investor,
              target.maxTranches || this.config.maxTranchesPerBatch
            );
          }
          processed++;
        } catch (err) {
          console.error(`Failed disbursing ${target.action} for ${target.investor}:`, err);
          errors++;
        }
      }
    }

    return { processed, errors, skippedForLowFunds: false };
  }

  /**
   * Route 1: Disburse primary claim_return
   */
  async disburseClaimReturn(poolContract: Contract, investor: string): Promise<string> {
    return this.executePermissionlessCall(poolContract, "claim_return", [
      new Address(investor).toScVal(),
    ]);
  }

  /**
   * Route 2: Disburse refund on expired pool
   */
  async disburseRefund(poolContract: Contract, investor: string): Promise<string> {
    return this.executePermissionlessCall(poolContract, "refund", [
      new Address(investor).toScVal(),
    ]);
  }

  /**
   * Route 3: Disburse secondary recovery tranche.
   * Validates integer bounds strictly [1..50] and encodes directly as xdr.ScVal.scvU32.
   */
  async disburseSecondaryRecovery(
    poolContract: Contract,
    investor: string,
    maxTranches: number
  ): Promise<string> {
    const rawVal = typeof maxTranches === "number" && Number.isInteger(maxTranches) ? maxTranches : 10;
    const boundedTranches = Math.max(1, Math.min(rawVal, 50));
    const tranchesVal = xdr.ScVal.scvU32(boundedTranches);
    return this.executePermissionlessCall(poolContract, "claim_secondary_recovery", [
      new Address(investor).toScVal(),
      tranchesVal,
    ]);
  }

  /**
   * Universal execution pipeline with Protocol 23 state restoration and strict confirmation.
   */
  private async executePermissionlessCall(
    poolContract: Contract,
    method: string,
    args: xdr.ScVal[]
  ): Promise<string> {
    const sponsorAccount = await this.server.getAccount(this.sponsorKey.publicKey());
    const baseInclusionFee = 100000n; // 0.01 XLM base inclusion fee

    const tx = new TransactionBuilder(sponsorAccount, {
      fee: baseInclusionFee.toString(),
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(poolContract.call(method, ...args))
      .setTimeout(30)
      .build();

    // 1. Simulate transaction via Soroban RPC
    const simRes = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simRes)) {
      throw new Error(`Simulation failed: ${simRes.error}`);
    }

    let preparedTx = rpc.assembleTransaction(tx, simRes).build();

    // 2. Standalone RestoreFootprintOp handling if required by restorePreamble
    if (simRes.restorePreamble && simRes.restorePreamble.minResourceFee) {
      const restoreAccount = await this.server.getAccount(this.sponsorKey.publicKey());
      // Total fee = Base Inclusion Fee + Resource Restoration Fee
      const totalRestoreFee = baseInclusionFee + BigInt(simRes.restorePreamble.minResourceFee);

      const restoreTxBuilder = new TransactionBuilder(restoreAccount, {
        fee: totalRestoreFee.toString(),
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(Operation.restoreFootprint({}))
        .setTimeout(30);

      if (simRes.restorePreamble.transactionData) {
        restoreTxBuilder.setSorobanData(simRes.restorePreamble.transactionData.build());
      }

      const restoreTx = restoreTxBuilder.build();
      restoreTx.sign(this.sponsorKey);
      const restoreSendRes = await this.server.sendTransaction(restoreTx);
      if (restoreSendRes.status === "ERROR") {
        throw new Error(`Restore footprint failed: ${restoreSendRes.errorResult?.toXDR("base64")}`);
      }

      await this.waitForConfirmation(restoreSendRes.hash);

      // Re-fetch sequence and re-simulate
      const freshAccount = await this.server.getAccount(this.sponsorKey.publicKey());
      const freshTx = new TransactionBuilder(freshAccount, {
        fee: baseInclusionFee.toString(),
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(poolContract.call(method, ...args))
        .setTimeout(30)
        .build();
      const freshSim = await this.server.simulateTransaction(freshTx);
      preparedTx = rpc.assembleTransaction(freshTx, freshSim).build();
    }

    // 3. Sign with sponsor key and submit
    preparedTx.sign(this.sponsorKey);
    const sendRes = await this.server.sendTransaction(preparedTx);

    if (sendRes.status === "ERROR") {
      throw new Error(`Transaction submission error: ${sendRes.errorResult?.toXDR("base64")}`);
    }

    await this.waitForConfirmation(sendRes.hash);
    return sendRes.hash;
  }

  /**
   * Poll RPC getTransaction with wall-clock deadline and strict SUCCESS verification.
   * Post-verifies deadline upon receiving response to strictly reject late responses.
   */
  private async waitForConfirmation(txHash: string): Promise<void> {
    const deadline = Date.now() + 45000; // Strict 45s wall-clock deadline

    while (Date.now() < deadline) {
      const res = await this.server.getTransaction(txHash);
      const now = Date.now();
      if (now > deadline) {
        throw new Error(`Transaction ${txHash} confirmation received past 45s deadline (took ${now - (deadline - 45000)}ms)`);
      }
      if (res.status === "SUCCESS") {
        return;
      }
      if (res.status === "FAILED") {
        throw new Error(`Transaction ${txHash} execution failed on-chain`);
      }
      // Check deadline before sleeping
      if (Date.now() + 2000 >= deadline) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Transaction ${txHash} confirmation timed out after 45s deadline`);
  }
}
