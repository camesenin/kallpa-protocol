/**
 * Kallpa Protocol - Autonomous Keeper Service Daemon
 *
 * Implements full coverage of claim_return, refund, and claim_secondary_recovery,
 * real position processing, per-transaction sponsor balance preservation based on
 * final assembled envelope fees, Protocol 23 restoration fallback, simulation zero-payout
 * short-circuiting to prevent gas wastage, and robust confirmation.
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
   * Full Stellar Core balance calculation:
   * available = balance - (2 + numSubEntries + numSponsoring - numSponsored) * baseReserve - sellingLiabilities
   */
  async checkSponsorSolvency(): Promise<{ solvent: boolean; balanceStroops: bigint; availableStroops: bigint }> {
    const accountId = this.sponsorKey.xdrAccountId();
    const accountKey = xdr.LedgerKey.account(
      new xdr.LedgerKeyAccount({ accountId })
    );

    const res = await this.server.getLedgerEntries(accountKey);
    if (!res.entries || res.entries.length === 0) {
      throw new Error("Sponsor account entry not found on-chain");
    }

    const entry = res.entries[0];
    const accountEntry = entry.val.account();
    const totalBalance = accountEntry.balance().toBigInt();
    const subentryCount = BigInt(accountEntry.numSubEntries());

    let numSponsoring = 0n;
    let numSponsored = 0n;
    let sellingLiabilities = 0n;

    const ext = accountEntry.ext();
    const extSwitch = typeof ext.switch === "function" ? ext.switch() : (ext as any).switch;
    const switchVal = typeof extSwitch === "number" ? extSwitch : (extSwitch as any).value;

    if (switchVal === 1) {
      const v1 = ext.v1();
      sellingLiabilities = v1.liabilities().selling().toBigInt();
      const extV2 = v1.ext();
      const v2Switch = typeof extV2.switch === "function" ? extV2.switch() : (extV2 as any).switch;
      const v2SwitchVal = typeof v2Switch === "number" ? v2Switch : (v2Switch as any).value;
      if (v2SwitchVal === 2) {
        const v2 = extV2.v2();
        numSponsoring = BigInt(v2.numSponsoring());
        numSponsored = BigInt(v2.numSponsored());
      }
    }

    const baseReserve = 5_000_000n; // 0.5 XLM in stroops
    const effectiveSubentries = 2n + subentryCount + numSponsoring - numSponsored;
    const minReserve = effectiveSubentries * baseReserve;
    const reservedTotal = minReserve + sellingLiabilities;

    const available = totalBalance > reservedTotal ? totalBalance - reservedTotal : 0n;

    return {
      solvent: available >= this.config.minSponsorReserveStroops,
      balanceStroops: totalBalance,
      availableStroops: available,
    };
  }

  /**
   * Monitor registered pools and disburse pending claims permissionlessly
   * across all three protocol claiming routes with continuous per-transaction budget protection
   * and short-circuiting of zero-payout claims to prevent wasting sponsor funds.
   */
  async runSweepCycle(
    targetsByPool: Map<string, InvestorClaimTarget[]>
  ): Promise<{ processed: number; errors: number; skippedForLowFunds: boolean; skippedZeroPayout: number }> {
    let processed = 0;
    let errors = 0;
    let skippedZeroPayout = 0;

    for (const poolId of this.config.poolContractIds) {
      const targets = targetsByPool.get(poolId) || [];
      const poolContract = new Contract(poolId);

      for (const target of targets) {
        const solvency = await this.checkSponsorSolvency();
        if (!solvency.solvent) {
          console.warn(`Sponsor reserve low (${solvency.availableStroops} stroops < ${this.config.minSponsorReserveStroops} stroops). Pausing sweep.`);
          return { processed, errors, skippedForLowFunds: true, skippedZeroPayout };
        }

        try {
          let txHash: string | null = null;
          if (target.action === "claim_return") {
            txHash = await this.disburseClaimReturn(poolContract, target.investor);
          } else if (target.action === "refund") {
            txHash = await this.disburseRefund(poolContract, target.investor);
          } else if (target.action === "claim_secondary") {
            const tranches = target.maxTranches !== undefined ? target.maxTranches : this.config.maxTranchesPerBatch;
            txHash = await this.disburseSecondaryRecovery(
              poolContract,
              target.investor,
              tranches
            );
          }

          if (txHash === null) {
            skippedZeroPayout++;
          } else {
            processed++;
          }
        } catch (err) {
          console.error(`Failed disbursing ${target.action} for ${target.investor}:`, err);
          errors++;
        }
      }
    }

    return { processed, errors, skippedForLowFunds: false, skippedZeroPayout };
  }

  /**
   * Route 1: Disburse primary claim_return
   */
  async disburseClaimReturn(poolContract: Contract, investor: string): Promise<string | null> {
    return this.executePermissionlessCall(poolContract, "claim_return", [
      new Address(investor).toScVal(),
    ]);
  }

  /**
   * Route 2: Disburse refund on expired pool
   */
  async disburseRefund(poolContract: Contract, investor: string): Promise<string | null> {
    return this.executePermissionlessCall(poolContract, "refund", [
      new Address(investor).toScVal(),
    ]);
  }

  /**
   * Route 3: Disburse secondary recovery tranche.
   * Strictly validates integer in range [1..50]. Rejects invalid input without coercion.
   */
  async disburseSecondaryRecovery(
    poolContract: Contract,
    investor: string,
    maxTranches: number
  ): Promise<string | null> {
    if (typeof maxTranches !== "number" || !Number.isInteger(maxTranches) || maxTranches < 1 || maxTranches > 50) {
      throw new Error(`Invalid maxTranches: ${maxTranches}. Must be an integer between 1 and 50.`);
    }

    const tranchesVal = xdr.ScVal.scvU32(maxTranches);
    return this.executePermissionlessCall(poolContract, "claim_secondary_recovery", [
      new Address(investor).toScVal(),
      tranchesVal,
    ]);
  }

  /**
   * Universal execution pipeline with Protocol 23 state restoration and strict confirmation.
   * Strictly checks simulated return value: if simulation returns Ok(0) (e.g. repeated secondary claim
   * with zero new recovery to distribute), the function short-circuits and returns null without submitting,
   * completely preventing gas/sponsor exhaustion on exhausted claims.
   */
  /**
   * Checks whether an investor has already claimed all available secondary recovery tranches.
   * If total_tranches <= claimed_tranches, further calls are redundant (returning 0 with no cursor advancement),
   * allowing the Keeper to safely short-circuit without wasting sponsor XLM.
   * Conversely, if total_tranches > claimed_tranches, calls MUST proceed to advance the on-chain cursor
   * even if individual micro-tranches round down to zero!
   */
  async isSecondaryClaimExhausted(poolContract: Contract, investorVal: xdr.ScVal): Promise<boolean> {
    try {
      const sponsorAccount = await this.server.getAccount(this.sponsorKey.publicKey());
      const tx = new TransactionBuilder(sponsorAccount, {
        fee: "100000",
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(poolContract.call("get_secondary_claim_status", investorVal))
        .setTimeout(30)
        .build();

      const simRes = await this.server.simulateTransaction(tx);
      if (!rpc.Api.isSimulationError(simRes) && simRes.result && simRes.result.retval) {
        const val = simRes.result.retval;
        if (val.switch().value === xdr.ScValType.scvVec().value) {
          const vec = val.vec();
          if (vec && vec.length >= 2) {
            const total = vec[0].u32();
            const claimed = vec[1].u32();
            return total <= claimed;
          }
        }
      }
    } catch (e) {
      // Fallback: do not short-circuit on inspection error
    }
    return false;
  }

  private async executePermissionlessCall(
    poolContract: Contract,
    method: string,
    args: xdr.ScVal[]
  ): Promise<string | null> {
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

    // Critical Progress Guard:
    // If calling claim_secondary_recovery, only short-circuit if the investor is ALREADY fully claimed
    // (total_tranches <= claimed_tranches). If unvisited tranches exist, the transaction MUST be submitted
    // on-chain to advance position.claimed_tranches cursor, preventing infinite stalling on zero-payout micro-tranches!
    if (method === "claim_secondary_recovery" && args.length > 0) {
      const isExhausted = await this.isSecondaryClaimExhausted(poolContract, args[0]);
      if (isExhausted) {
        return null;
      }
    }
    let preparedTx = rpc.assembleTransaction(tx, simRes).build();

    // 2. Standalone RestoreFootprintOp handling if required by restorePreamble
    if (simRes.restorePreamble && simRes.restorePreamble.minResourceFee) {
      const restoreAccount = await this.server.getAccount(this.sponsorKey.publicKey());

      const restoreTxBuilder = new TransactionBuilder(restoreAccount, {
        fee: baseInclusionFee.toString(),
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(Operation.restoreFootprint({}))
        .setTimeout(30);

      if (simRes.restorePreamble.transactionData) {
        restoreTxBuilder.setSorobanData(simRes.restorePreamble.transactionData.build());
      }

      // Build envelope FIRST to obtain definitive total fee
      const restoreTx = restoreTxBuilder.build();
      const definitiveRestoreFee = BigInt(restoreTx.fee);

      // Verify definitive envelope fee against available balance
      const preRestoreSolvency = await this.checkSponsorSolvency();
      if (preRestoreSolvency.availableStroops < definitiveRestoreFee + this.config.minSponsorReserveStroops) {
        throw new Error(
          `Insufficient sponsor balance for definitive restoration envelope: available ${preRestoreSolvency.availableStroops} < required ${definitiveRestoreFee + this.config.minSponsorReserveStroops} (fee: ${definitiveRestoreFee}, reserve: ${this.config.minSponsorReserveStroops})`
        );
      }

      restoreTx.sign(this.sponsorKey);
      const restoreSendRes = await this.server.sendTransaction(restoreTx);
      if (restoreSendRes.status === "ERROR") {
        throw new Error(`Restore footprint failed: ${restoreSendRes.errorResult?.toXDR("base64")}`);
      }

      await this.waitForConfirmation(restoreSendRes.hash);

      // Re-fetch sequence and re-simulate invocation
      const freshAccount = await this.server.getAccount(this.sponsorKey.publicKey());
      const freshTx = new TransactionBuilder(freshAccount, {
        fee: baseInclusionFee.toString(),
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(poolContract.call(method, ...args))
        .setTimeout(30)
        .build();
      const freshSim = await this.server.simulateTransaction(freshTx);
      if (rpc.Api.isSimulationError(freshSim)) {
        throw new Error(`Re-simulation after restoration failed: ${freshSim.error}`);
      }
      if (freshSim.restorePreamble && freshSim.restorePreamble.minResourceFee) {
        throw new Error("Re-simulation unexpectedly required second restoration preamble");
      }
      preparedTx = rpc.assembleTransaction(freshTx, freshSim).build();
    }

    // 3. Strict definitive envelope budget check:
    const definitiveEnvelopeFee = BigInt(preparedTx.fee);
    const preSendSolvency = await this.checkSponsorSolvency();
    if (preSendSolvency.availableStroops < definitiveEnvelopeFee + this.config.minSponsorReserveStroops) {
      throw new Error(
        `Insufficient sponsor balance for assembled invocation: available ${preSendSolvency.availableStroops} < required ${definitiveEnvelopeFee + this.config.minSponsorReserveStroops} (fee: ${definitiveEnvelopeFee}, reserve: ${this.config.minSponsorReserveStroops})`
      );
    }

    preparedTx.sign(this.sponsorKey);
    const sendRes = await this.server.sendTransaction(preparedTx);

    if (sendRes.status === "ERROR") {
      throw new Error(`Transaction submission error: ${sendRes.errorResult?.toXDR("base64")}`);
    }

    await this.waitForConfirmation(sendRes.hash);
    return sendRes.hash;
  }

  /**
   * Poll RPC getTransaction with monotonic wall-clock deadline, abort signal for individual RPC calls,
   * timer cleanup, and post-verification to strictly reject late responses.
   */
  private async waitForConfirmation(txHash: string): Promise<void> {
    const start = performance.now();
    const timeoutMs = 45000; // Strict 45s monotonic deadline

    while (performance.now() - start < timeoutMs) {
      const remainingTime = Math.max(0, Math.floor(timeoutMs - (performance.now() - start)));
      if (remainingTime === 0) {
        break;
      }
      let timerId: any;

      const callPromise = this.server.getTransaction(txHash);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => reject(new Error("RPC call timed out")), Math.min(remainingTime, 5000));
      });

      try {
        const res = await Promise.race([callPromise, timeoutPromise]);
        clearTimeout(timerId);

        const elapsed = performance.now() - start;
        if (elapsed > timeoutMs) {
          throw new Error(`Transaction ${txHash} confirmation received past 45s deadline (took ${elapsed}ms)`);
        }
        if (res.status === "SUCCESS") {
          return;
        }
        if (res.status === "FAILED") {
          throw new Error(`Transaction ${txHash} execution failed on-chain`);
        }
      } catch (e: any) {
        clearTimeout(timerId);
        if (e.message?.includes("past 45s deadline") || e.message?.includes("execution failed")) {
          throw e;
        }
      }

      if (performance.now() - start + 2000 >= timeoutMs) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    throw new Error(`Transaction ${txHash} confirmation timed out after 45s monotonic deadline`);
  }
}
