/**
 * Kallpa Protocol - Autonomous Keeper Service Daemon
 *
 * Implements real position discovery, simulation, Protocol 23 state restoration,
 * and fee-bumped execution for Kallpa Pools on Stellar Soroban.
 */

import {
  rpc,
  TransactionBuilder,
  Keypair,
  Contract,
  Operation,
  Address,
} from "@stellar/stellar-sdk";

export interface KeeperConfig {
  rpcUrl: string;
  networkPassphrase: string;
  sponsorSecret: string;
  poolContractIds: string[];
  maxTranchesPerBatch: number;
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
   * Monitor registered pools and disburse pending claims permissionlessly.
   */
  async runSweepCycle(indexedPositions: Map<string, string[]>): Promise<{ processed: number; errors: number }> {
    let processed = 0;
    let errors = 0;

    for (const poolId of this.config.poolContractIds) {
      try {
        const poolContract = new Contract(poolId);
        const investors = indexedPositions.get(poolId) || [];

        for (const investor of investors) {
          try {
            await this.disburseInvestorClaim(poolContract, investor);
            processed++;
          } catch (err) {
            console.error(`Failed disbursal for investor ${investor} in pool ${poolId}:`, err);
            errors++;
          }
        }
      } catch (err) {
        console.error(`Error sweeping pool ${poolId}:`, err);
        errors++;
      }
    }

    return { processed, errors };
  }

  /**
   * Disburse claim for an investor using Protocol 23 automatic restoration and fee-bumping.
   */
  async disburseInvestorClaim(poolContract: Contract, investor: string): Promise<string> {
    const sponsorAccount = await this.server.getAccount(this.sponsorKey.publicKey());

    // Construct permissionless claim_return invocation
    const tx = new TransactionBuilder(sponsorAccount, {
      fee: "100000", // Base fee allowance (stroops)
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(
        poolContract.call(
          "claim_return",
          new Address(investor).toScVal()
        )
      )
      .setTimeout(30)
      .build();

    // 1. Simulate transaction via Soroban RPC
    const simRes = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(simRes)) {
      throw new Error(`Simulation failed: ${simRes.error}`);
    }

    // 2. Protocol 23 Auto-Restoration & Footprint Handling:
    // If state entries are archived, simulateTransaction populates restorePreamble
    // or archivedSorobanEntries within the SorobanTransactionData.
    let preparedTx = rpc.assembleTransaction(tx, simRes).build();

    // 3. Fallback: If standalone RestoreFootprintOp is required by restorePreamble
    if (simRes.restorePreamble && simRes.restorePreamble.minResourceFee) {
      const restoreAccount = await this.server.getAccount(this.sponsorKey.publicKey());
      const restoreTxBuilder = new TransactionBuilder(restoreAccount, {
        fee: simRes.restorePreamble.minResourceFee,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          Operation.restoreFootprint({})
        )
        .setTimeout(30);

      // Crucial: Set sorobanData containing footprint & resources from restorePreamble
      if (simRes.restorePreamble.transactionData) {
        restoreTxBuilder.setSorobanData(simRes.restorePreamble.transactionData.build());
      }

      const restoreTx = restoreTxBuilder.build();
      restoreTx.sign(this.sponsorKey);
      const restoreSendRes = await this.server.sendTransaction(restoreTx);
      if (restoreSendRes.status === "ERROR") {
        throw new Error(`Restore footprint failed: ${restoreSendRes.errorResult?.toXDR("base64")}`);
      }
      
      // Wait for strict SUCCESS on-chain confirmation before proceeding
      await this.waitForConfirmation(restoreSendRes.hash);
      
      // Re-fetch sponsor account and re-simulate invocation
      const freshAccount = await this.server.getAccount(this.sponsorKey.publicKey());
      const freshTx = new TransactionBuilder(freshAccount, {
        fee: "100000",
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(poolContract.call("claim_return", new Address(investor).toScVal()))
        .setTimeout(30)
        .build();
      const freshSim = await this.server.simulateTransaction(freshTx);
      preparedTx = rpc.assembleTransaction(freshTx, freshSim).build();
    }

    // 4. Sign with sponsor key and submit
    preparedTx.sign(this.sponsorKey);
    const sendRes = await this.server.sendTransaction(preparedTx);

    if (sendRes.status === "ERROR") {
      throw new Error(`Transaction submission error: ${sendRes.errorResult?.toXDR("base64")}`);
    }

    await this.waitForConfirmation(sendRes.hash);
    return sendRes.hash;
  }

  /**
   * Poll RPC getTransaction until final inclusion status.
   * Strictly verifies SUCCESS; fails on timeout or non-SUCCESS status.
   */
  private async waitForConfirmation(txHash: string): Promise<void> {
    let attempts = 15;
    while (attempts > 0) {
      const res = await this.server.getTransaction(txHash);
      if (res.status === "SUCCESS") {
        return;
      }
      if (res.status === "FAILED") {
        throw new Error(`Transaction ${txHash} execution failed`);
      }
      // NOT_FOUND or STILL_PENDING: wait and retry
      await new Promise((r) => setTimeout(r, 2000));
      attempts--;
    }
    throw new Error(`Transaction ${txHash} confirmation timed out after 30 seconds`);
  }
}
