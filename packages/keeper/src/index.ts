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
  minSponsorReserveXlm: number; // e.g. 5 XLM safety threshold
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
   * Check sponsor XLM balance to ensure sufficient gas coverage.
   */
  async checkSponsorSolvency(): Promise<{ solvent: boolean; balanceXlm: number }> {
    const account = await this.server.getAccount(this.sponsorKey.publicKey());
    // Find native balance
    let nativeBalance = 0;
    for (const b of (account as any).balances || []) {
      if (b.asset_type === "native") {
        nativeBalance = parseFloat(b.balance);
      }
    }
    return {
      solvent: nativeBalance >= this.config.minSponsorReserveXlm,
      balanceXlm: nativeBalance,
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
      console.warn(`Sponsor reserve low (${solvency.balanceXlm} XLM < ${this.config.minSponsorReserveXlm} XLM). Pausing sweep.`);
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
   * Route 3: Disburse secondary recovery tranche
   */
  async disburseSecondaryRecovery(
    poolContract: Contract,
    investor: string,
    maxTranches: number
  ): Promise<string> {
    const tranchesVal = xdr.ScVal.scvU32(maxTranches);
    const optVal = xdr.ScVal.scvVec([tranchesVal]); // Option::Some(maxTranches)
    return this.executePermissionlessCall(poolContract, "claim_secondary_recovery", [
      new Address(investor).toScVal(),
      optVal,
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

    const tx = new TransactionBuilder(sponsorAccount, {
      fee: "100000",
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
      const restoreTxBuilder = new TransactionBuilder(restoreAccount, {
        fee: simRes.restorePreamble.minResourceFee,
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
        fee: "100000",
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
   * Poll RPC getTransaction with wall-clock timeout and strict SUCCESS verification.
   */
  private async waitForConfirmation(txHash: string): Promise<void> {
    const startTime = Date.now();
    const timeoutMs = 45000; // 45s wall-clock timeout

    while (Date.now() - startTime < timeoutMs) {
      const res = await this.server.getTransaction(txHash);
      if (res.status === "SUCCESS") {
        return;
      }
      if (res.status === "FAILED") {
        throw new Error(`Transaction ${txHash} execution failed on-chain`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Transaction ${txHash} confirmation timed out after ${timeoutMs}ms`);
  }
}
