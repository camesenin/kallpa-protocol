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
  SorobanDataBuilder,
  xdr,
  StrKey,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";

export interface KeeperConfig {
  rpcUrl: string;
  networkPassphrase: string;
  sponsorSecret: string;
  poolContractIds: string[];
  maxTranchesPerBatch: number;
  minSponsorReserveStroops: bigint; // e.g. 50_000_000n (5 XLM safety cushion threshold)
  maxFeePerTxStroops?: bigint; // Maximum fee willing to pay per single envelope (e.g. 2_000_000n = 0.2 XLM)
  maxSweepBudgetStroops?: bigint; // Maximum cumulative spend per single sweep cycle (e.g. 20_000_000n = 2 XLM)
  maxZeroPayoutTranchesPerCycle?: number; // Maximum zero-payout advancement tranches permitted per cycle to bound unmonetized subsidies
  storagePath?: string; // Optional path for durable disk-backed reservation persistence
}

export interface InvestorClaimTarget {
  investor: string;
  action: "claim_return" | "refund" | "claim_secondary";
  maxTranches?: number;
}

export enum ClaimPayoutType {
  Positive = "POSITIVE",
  Zero = "ZERO",
  Unknown = "UNKNOWN",
}

export interface ClaimExecutionReceipt {
  txHash: string | null;
  committedFeeStroops: bigint; // Maximum committed envelope fee reserved before dispatch
  effectiveFeeStroops: bigint; // Exact on-chain fee charged after confirmed execution
  feeSpentStroops: bigint; // Backwards compatible alias for effectiveFeeStroops
  payoutStroops: bigint; // Confirmed on-chain payout amount returned by contract invocation
  tranchesAdvanced?: number; // Exact count of persistent tranches advanced on-chain
  resultMetaXdr?: any; // Raw or parsed TransactionMeta from RPC response
}

export interface PendingTxReservation {
  txHash: string;
  committedFeeStroops: bigint;
  timestamp: number;
}

export class KallpaKeeperDaemon {
  private server: rpc.Server;
  private sponsorKey: Keypair;
  private config: KeeperConfig;
  private isSweepCycleActive: boolean = false;
  private pendingReservations: Map<string, PendingTxReservation> = new Map();
  private storageFile: string | null = null;

  constructor(config: KeeperConfig) {
    this.config = config;
    this.server = new rpc.Server(config.rpcUrl);
    this.sponsorKey = Keypair.fromSecret(config.sponsorSecret);
    if (config.storagePath) {
      this.storageFile = config.storagePath;
      this.loadDurableReservations();
    }
  }

  private loadDurableReservations(): void {
    if (!this.storageFile) return;
    try {
      if (fs.existsSync(this.storageFile)) {
        const raw = fs.readFileSync(this.storageFile, "utf-8");
        const list: Array<{ txHash: string; committedFeeStroops: string; timestamp: number }> = JSON.parse(raw);
        for (const item of list) {
          this.pendingReservations.set(item.txHash, {
            txHash: item.txHash,
            committedFeeStroops: BigInt(item.committedFeeStroops),
            timestamp: item.timestamp,
          });
        }
      }
    } catch (e) {
      // In case of corrupt file or read error, fallback to empty in-memory state
    }
  }

  private persistDurableReservations(): void {
    if (!this.storageFile) return;
    try {
      const list = Array.from(this.pendingReservations.values()).map(r => ({
        txHash: r.txHash,
        committedFeeStroops: r.committedFeeStroops.toString(),
        timestamp: r.timestamp,
      }));
      const dir = path.dirname(this.storageFile);
      if (dir && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpFile = `${this.storageFile}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpFile, JSON.stringify(list, null, 2), "utf-8");
      // Atomic rename guarantees crash-proof durable storage
      fs.renameSync(tmpFile, this.storageFile);
    } catch (e: any) {
      throw new Error(`Critical: Failed to persist durable keeper reservations: ${e.message}`);
    }
  }

  /**
   * Helper to parse integer/i128 amount from an ScVal
   */
  private parseScValAmount(val: xdr.ScVal | undefined): bigint {
    if (!val) return 0n;
    try {
      const sw = val.switch().value;
      if (sw === xdr.ScValType.scvI128().value) {
        const lo = val.i128().lo().toBigInt();
        const hi = val.i128().hi().toBigInt();
        return (hi << 64n) + lo;
      } else if (sw === xdr.ScValType.scvU128().value) {
        const lo = val.u128().lo().toBigInt();
        const hi = val.u128().hi().toBigInt();
        return (hi << 64n) + lo;
      } else if (sw === xdr.ScValType.scvI64().value) {
        return val.i64().toBigInt();
      } else if (sw === xdr.ScValType.scvU64().value) {
        return val.u64().toBigInt();
      }
    } catch (e) {
      // Fallback
    }
    return 0n;
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

    // Deduct unconfirmed pending transaction reservations from available balance
    let totalPendingReserved = 0n;
    for (const res of this.pendingReservations.values()) {
      totalPendingReserved += res.committedFeeStroops;
    }
    const netAvailable = available > totalPendingReserved ? available - totalPendingReserved : 0n;

    return {
      solvent: netAvailable >= this.config.minSponsorReserveStroops,
      balanceStroops: totalBalance,
      availableStroops: netAvailable,
    };
  }

  /**
   * Reconcile any existing pending reservations by querying RPC getTransaction.
   * If transaction is finalized (SUCCESS or FAILED), the reservation is cleanly released.
   * If older than 10 minutes (past protocol transaction TTL validity), it is safely pruned.
   */
  public async reconcilePendingReservations(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [txHash, reservation] of Array.from(this.pendingReservations.entries())) {
      try {
        const res = await this.server.getTransaction(txHash);
        if (res.status === "SUCCESS" || res.status === "FAILED") {
          this.pendingReservations.delete(txHash);
          changed = true;
          continue;
        }
      } catch (e) {
        // RPC error or not found yet
      }
      // Prune expired after 10m (well past 30s envelope validity timeout)
      if (now - reservation.timestamp > 600_000) {
        this.pendingReservations.delete(txHash);
        changed = true;
      }
    }
    if (changed) {
      this.persistDurableReservations();
    }
  }

  /**
   * Monitor registered pools and disburse pending claims permissionlessly
   * across all three protocol claiming routes with continuous per-transaction budget protection
   * and short-circuiting of zero-payout claims to prevent wasting sponsor funds.
   */
  async runSweepCycle(
    targetsByPool: Map<string, InvestorClaimTarget[]>
  ): Promise<{
    processed: number;
    errors: number;
    skippedForLowFunds: boolean;
    skippedExhausted: number;
    confirmedZeroPayoutAdvancements: number;
    totalFeeSpentStroops: bigint;
    totalCommittedFeeStroops: bigint;
  }> {
    if (this.isSweepCycleActive) {
      throw new Error("Concurrent sweep cycle rejected: daemon is already executing an active cycle");
    }
    this.isSweepCycleActive = true;
    try {
      await this.reconcilePendingReservations();
      return await this._runSweepCycleInternal(targetsByPool);
    } finally {
      this.isSweepCycleActive = false;
    }
  }

  private async _runSweepCycleInternal(
    targetsByPool: Map<string, InvestorClaimTarget[]>
  ): Promise<{
    processed: number;
    errors: number;
    skippedForLowFunds: boolean;
    skippedExhausted: number;
    confirmedZeroPayoutAdvancements: number;
    totalFeeSpentStroops: bigint;
    totalCommittedFeeStroops: bigint;
  }> {
    let processed = 0;
    let errors = 0;
    let skippedExhausted = 0;
    let confirmedZeroPayoutAdvancements = 0;
    let totalFeeSpentStroops = 0n;
    let totalCommittedFeeStroops = 0n;

    const maxSweepBudget = this.config.maxSweepBudgetStroops ?? 50_000_000n; // Default 5 XLM ceiling per cycle
    const maxZeroPayouts = this.config.maxZeroPayoutTranchesPerCycle ?? 100; // Bound unmonetized zero-payout advancement subsidies

    for (const poolId of this.config.poolContractIds) {
      const targets = targetsByPool.get(poolId) || [];
      const poolContract = new Contract(poolId);

      for (const target of targets) {
        const solvency = await this.checkSponsorSolvency();
        if (!solvency.solvent) {
          console.warn(`Sponsor reserve low (${solvency.availableStroops} stroops < ${this.config.minSponsorReserveStroops} stroops). Pausing sweep.`);
          return {
            processed,
            errors,
            skippedForLowFunds: true,
            skippedExhausted,
            confirmedZeroPayoutAdvancements,
            totalFeeSpentStroops,
            totalCommittedFeeStroops,
          };
        }

        // Strict Pre-Flight Budget Reservation:
        // Do NOT proceed if total committed capacity cannot accommodate another transaction!
        if (totalCommittedFeeStroops >= maxSweepBudget) {
          console.warn(`Cumulative sweep budget ceiling reached (${totalCommittedFeeStroops} >= ${maxSweepBudget} stroops). Pausing cycle.`);
          return {
            processed,
            errors,
            skippedForLowFunds: false,
            skippedExhausted,
            confirmedZeroPayoutAdvancements,
            totalFeeSpentStroops,
            totalCommittedFeeStroops,
          };
        }

        const remainingBudget = maxSweepBudget - totalCommittedFeeStroops;

        // Secondary claim pre-flight quota reservation & status verification:
        let expectedBatchAdvancement = 0;
        if (target.action === "claim_secondary") {
          const investorVal = new Address(target.investor).toScVal();
          const isExhausted = await this.isSecondaryClaimExhausted(poolContract, investorVal);
          if (isExhausted) {
            skippedExhausted++;
            continue;
          }

          const claimStatus = await this.getSecondaryClaimStatus(poolContract, investorVal);
          const requestedBatch = target.maxTranches !== undefined ? target.maxTranches : this.config.maxTranchesPerBatch;
          // Exact persistent tranches that will be advanced: min(requestedBatch, remaining)
          expectedBatchAdvancement = claimStatus.remaining > 0 ? Math.min(requestedBatch, claimStatus.remaining) : requestedBatch;

          // STRICT PRE-FLIGHT QUOTA RESERVATION:
          // Check if adding expectedBatchAdvancement exceeds remaining zero-payout subsidy budget
          const remainingZeroPayoutQuota = maxZeroPayouts - confirmedZeroPayoutAdvancements;
          if (expectedBatchAdvancement > remainingZeroPayoutQuota) {
            // Proposed batch cannot fit entirely into remaining subsidy quota.
            // Check if claim yields positive payout or is zero/unknown:
            const payoutType = await this.isClaimZeroPayout(
              poolContract,
              "claim_secondary_recovery",
              [investorVal, xdr.ScVal.scvU32(requestedBatch)]
            );
            if (payoutType === ClaimPayoutType.Zero || payoutType === ClaimPayoutType.Unknown) {
              console.warn(
                `Subsidized zero-payout batch (${expectedBatchAdvancement} tranches) exceeds remaining quota (${remainingZeroPayoutQuota}). Skipping ${payoutType} claim for ${target.investor}.`
              );
              continue;
            }
          }
        }

        try {
          let receipt: ClaimExecutionReceipt = {
            txHash: null,
            committedFeeStroops: 0n,
            effectiveFeeStroops: 0n,
            feeSpentStroops: 0n,
            payoutStroops: 0n,
          };

          if (target.action === "claim_return") {
            receipt = await this.disburseClaimReturnWithReceipt(poolContract, target.investor, remainingBudget);
          } else if (target.action === "refund") {
            receipt = await this.disburseRefundWithReceipt(poolContract, target.investor, remainingBudget);
          } else if (target.action === "claim_secondary") {
            const tranches = target.maxTranches !== undefined ? target.maxTranches : this.config.maxTranchesPerBatch;
            receipt = await this.disburseSecondaryRecoveryWithReceipt(
              poolContract,
              target.investor,
              tranches,
              remainingBudget
            );
          }

          const committed = receipt.committedFeeStroops ?? receipt.feeSpentStroops ?? 0n;
          const effective = receipt.effectiveFeeStroops ?? receipt.feeSpentStroops ?? 0n;
          totalCommittedFeeStroops += committed;
          totalFeeSpentStroops += effective;

          if (receipt.txHash === null) {
            skippedExhausted++;
          } else {
            processed++;
            if (receipt.payoutStroops === 0n && target.action === "claim_secondary") {
              // Count EXACT confirmed on-chain tranches advanced from receipt or pre-flight calculation
              const actualAdvanced = receipt.tranchesAdvanced !== undefined ? receipt.tranchesAdvanced : (expectedBatchAdvancement > 0 ? expectedBatchAdvancement : (target.maxTranches !== undefined ? target.maxTranches : this.config.maxTranchesPerBatch));
              confirmedZeroPayoutAdvancements += actualAdvanced;
            }
          }
        } catch (err: any) {
          console.error(`Failed disbursing ${target.action} for ${target.investor}:`, err);
          errors++;
          // If transaction committed fee before failure (or restoration occurred), account for committed fee
          if (err && typeof err.committedFeeStroops === "bigint") {
            totalCommittedFeeStroops += err.committedFeeStroops;
            totalFeeSpentStroops += err.effectiveFeeStroops ?? err.committedFeeStroops;
          }
        }
      }
    }

    return {
      processed,
      errors,
      skippedForLowFunds: false,
      skippedExhausted,
      confirmedZeroPayoutAdvancements,
      totalFeeSpentStroops,
      totalCommittedFeeStroops,
    };
  }

  /**
   * Route 1: Disburse primary claim_return
   */
  async disburseClaimReturn(poolContract: Contract, investor: string): Promise<string | null> {
    const res = await this.disburseClaimReturnWithReceipt(poolContract, investor);
    return res.txHash;
  }

  async disburseClaimReturnWithReceipt(
    poolContract: Contract,
    investor: string,
    remainingBudget?: bigint
  ): Promise<ClaimExecutionReceipt> {
    return this.executePermissionlessCall(
      poolContract,
      "claim_return",
      [new Address(investor).toScVal()],
      remainingBudget
    );
  }

  /**
   * Route 2: Disburse refund on expired pool
   */
  async disburseRefund(poolContract: Contract, investor: string): Promise<string | null> {
    const res = await this.disburseRefundWithReceipt(poolContract, investor);
    return res.txHash;
  }

  async disburseRefundWithReceipt(
    poolContract: Contract,
    investor: string,
    remainingBudget?: bigint
  ): Promise<ClaimExecutionReceipt> {
    return this.executePermissionlessCall(
      poolContract,
      "refund",
      [new Address(investor).toScVal()],
      remainingBudget
    );
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
    const res = await this.disburseSecondaryRecoveryWithReceipt(poolContract, investor, maxTranches);
    return res.txHash;
  }

  async disburseSecondaryRecoveryWithReceipt(
    poolContract: Contract,
    investor: string,
    maxTranches: number,
    remainingBudget?: bigint
  ): Promise<ClaimExecutionReceipt> {
    if (
      typeof maxTranches !== "number" ||
      !Number.isInteger(maxTranches) ||
      maxTranches < 1 ||
      maxTranches > 50 ||
      Number.isNaN(maxTranches)
    ) {
      throw new Error(`Invalid maxTranches: ${maxTranches}. Must be an integer between 1 and 50.`);
    }

    const scValInvestor = new Address(investor).toScVal();
    const scValMax = xdr.ScVal.scvU32(maxTranches);

    // Pre-query status to record exact persistent tranches to be advanced
    const statusBefore = await this.getSecondaryClaimStatus(poolContract, scValInvestor);
    const expectedAdvancement = statusBefore.remaining > 0 ? Math.min(maxTranches, statusBefore.remaining) : maxTranches;

    const receipt = await this.executePermissionlessCall(
      poolContract,
      "claim_secondary_recovery",
      [scValInvestor, scValMax],
      remainingBudget
    );
    if (receipt.txHash !== null) {
      // 1. Authoritative Attribution: Attempt exact derivation from confirmed transaction event metadata
      let eventTranches: number | null = null;
      const contractId = typeof poolContract.contractId === "function" ? poolContract.contractId() : undefined;
      if (receipt.resultMetaXdr) {
        eventTranches = this.extractTranchesAdvancedFromMeta(receipt.resultMetaXdr, contractId, investor);
      }

      if (eventTranches !== null) {
        receipt.tranchesAdvanced = eventTranches;
      } else {
        // 2. Strict Zero Attribution: If event not present in confirmed metadata, do NOT attribute phantom tranches!
        receipt.tranchesAdvanced = 0;
      }
    }
    return receipt;
  }

  /**
   * Query contract for investor's current secondary recovery claim status: (total_tranches, claimed_tranches).
   * Returns exact tuple from contract storage.
   */
  public async getSecondaryClaimStatus(
    poolContract: Contract,
    investorVal: xdr.ScVal
  ): Promise<{ total: number; claimed: number; remaining: number }> {
    try {
      const sponsorAccount = await this.server.getAccount(this.sponsorKey.publicKey());
      const tx = new TransactionBuilder(sponsorAccount, {
        fee: "100",
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(poolContract.call("get_secondary_claim_status", investorVal))
        .setTimeout(30)
        .build();

      const simRes = await this.server.simulateTransaction(tx);
      if (simRes.result && simRes.result.retval) {
        const val = simRes.result.retval;
        if (val.switch().value === xdr.ScValType.scvVec().value) {
          const vec = val.vec();
          if (vec && vec.length >= 2) {
            const total = vec[0].u32();
            const claimed = vec[1].u32();
            const remaining = total > claimed ? total - claimed : 0;
            return { total, claimed, remaining };
          }
        }
      }
    } catch (e) {
      // Fallback on inspection error
    }
    return { total: 0, claimed: 0, remaining: 0 };
  }

  /**
   * Check if investor has already claimed all secondary tranches
   */
  public async isSecondaryClaimExhausted(poolContract: Contract, investorVal: xdr.ScVal): Promise<boolean> {
    const status = await this.getSecondaryClaimStatus(poolContract, investorVal);
    // If status returns total > 0 and remaining === 0, it is definitively exhausted
    if (status.total > 0 && status.remaining === 0) {
      return true;
    }
    return false;
  }

  /**
   * Check if a claim produces 0 payout via simulation
   */
  /**
   * Check claim payout status via simulation.
   * Returns ternary ClaimPayoutType (Positive, Zero, or Unknown)
   * to strictly prevent treating RPC/simulation errors as positive payouts.
   */
  public async isClaimZeroPayout(
    poolContract: Contract,
    method: string,
    args: xdr.ScVal[]
  ): Promise<ClaimPayoutType> {
    try {
      const sponsorAccount = await this.server.getAccount(this.sponsorKey.publicKey());
      const tx = new TransactionBuilder(sponsorAccount, {
        fee: "100",
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(poolContract.call(method, ...args))
        .setTimeout(30)
        .build();

      const simRes = await this.server.simulateTransaction(tx);
      if (simRes.result && simRes.result.retval) {
        const payout = this.parseScValAmount(simRes.result.retval);
        return payout === 0n ? ClaimPayoutType.Zero : ClaimPayoutType.Positive;
      }
    } catch (e) {
      // Fallback: inspection error -> Unknown
      return ClaimPayoutType.Unknown;
    }
    return ClaimPayoutType.Unknown;
  }

  private async executePermissionlessCall(
    poolContract: Contract,
    method: string,
    args: xdr.ScVal[],
    remainingBudget?: bigint
  ): Promise<ClaimExecutionReceipt> {
    const sponsorAccount = await this.server.getAccount(this.sponsorKey.publicKey());
    const baseInclusionFee = 100000n; // 0.01 XLM base inclusion fee
    const maxFeeLimit = this.config.maxFeePerTxStroops ?? 5_000_000n; // 0.5 XLM default max fee ceiling

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
    // on-chain to advance position.claimed_tranches cursor!
    if (method === "claim_secondary_recovery" && args.length > 0) {
      const isExhausted = await this.isSecondaryClaimExhausted(poolContract, args[0]);
      if (isExhausted) {
        return {
          txHash: null,
          committedFeeStroops: 0n,
          effectiveFeeStroops: 0n,
          feeSpentStroops: 0n,
          payoutStroops: 0n,
        };
      }
    }

    const preparedTxBuilder = rpc.assembleTransaction(tx, simRes);
    if (simRes.minResourceFee) {
      const rawData =
        simRes.transactionData && typeof (simRes.transactionData as any).build === "function"
          ? (simRes.transactionData as any).build()
          : simRes.transactionData;
      const sorobanDataBuilder = new SorobanDataBuilder(rawData);
      sorobanDataBuilder.setResourceFee(simRes.minResourceFee);
      preparedTxBuilder.setSorobanData(sorobanDataBuilder.build());
    }
    let preparedTx = preparedTxBuilder.build();
    let totalCommittedFee = 0n;
    let totalEffectiveFee = 0n;

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
        const rawData =
          typeof (simRes.restorePreamble.transactionData as any).build === "function"
            ? (simRes.restorePreamble.transactionData as any).build()
            : simRes.restorePreamble.transactionData;
        const sorobanDataBuilder = new SorobanDataBuilder(rawData);
        if (simRes.restorePreamble.minResourceFee) {
          sorobanDataBuilder.setResourceFee(simRes.restorePreamble.minResourceFee);
        }
        restoreTxBuilder.setSorobanData(sorobanDataBuilder.build());
      }

      // Build envelope FIRST to obtain definitive total fee
      const restoreTx = restoreTxBuilder.build();
      const definitiveRestoreFee = BigInt(restoreTx.fee);

      // STRICT POLICY: Enforce maxFeePerTxStroops on restoration envelope!
      if (definitiveRestoreFee > maxFeeLimit) {
        throw new Error(
          `Restoration envelope fee exceeds maximum allowable per-transaction policy: fee ${definitiveRestoreFee} > maxFeeLimit ${maxFeeLimit}`
        );
      }

      // STRICT PRE-FLIGHT CYCLE BUDGET: Verify restoration fee does not exceed cycle remaining budget
      if (remainingBudget !== undefined && definitiveRestoreFee > remainingBudget) {
        throw new Error(
          `Restoration fee exceeds remaining cycle budget: fee ${definitiveRestoreFee} > remaining ${remainingBudget}`
        );
      }

      // Verify definitive envelope fee against available balance
      const preRestoreSolvency = await this.checkSponsorSolvency();
      if (preRestoreSolvency.availableStroops < definitiveRestoreFee + this.config.minSponsorReserveStroops) {
        throw new Error(
          `Insufficient sponsor balance for definitive restoration envelope: available ${preRestoreSolvency.availableStroops} < required ${definitiveRestoreFee + this.config.minSponsorReserveStroops} (fee: ${definitiveRestoreFee}, reserve: ${this.config.minSponsorReserveStroops})`
        );
      }

      restoreTx.sign(this.sponsorKey);
      const computedRestoreHash = restoreTx.hash().toString("hex");

      // WAL: Persist restoration envelope fee BEFORE dispatching to network
      this.pendingReservations.set(computedRestoreHash, {
        txHash: computedRestoreHash,
        committedFeeStroops: definitiveRestoreFee,
        timestamp: Date.now(),
      });
      this.persistDurableReservations();

      let restoreSendRes: rpc.Api.SendTransactionResponse;
      try {
        restoreSendRes = await this.server.sendTransaction(restoreTx);
      } catch (transportErr: any) {
        transportErr.committedFeeStroops = definitiveRestoreFee;
        transportErr.effectiveFeeStroops = definitiveRestoreFee;
        throw transportErr;
      }
      if (restoreSendRes.status === "ERROR") {
        this.pendingReservations.delete(computedRestoreHash);
        this.persistDurableReservations();
        throw new Error(`Restore footprint failed: ${restoreSendRes.errorResult?.toXDR("base64")}`);
      }

      if (restoreSendRes.hash && restoreSendRes.hash !== computedRestoreHash) {
        this.pendingReservations.delete(computedRestoreHash);
        this.pendingReservations.set(restoreSendRes.hash, {
          txHash: restoreSendRes.hash,
          committedFeeStroops: definitiveRestoreFee,
          timestamp: Date.now(),
        });
        this.persistDurableReservations();
      }

      const activeRestoreHash = restoreSendRes.hash || computedRestoreHash;

      try {
        const restoreTxMeta = await this.waitForConfirmation(activeRestoreHash);
        totalCommittedFee += definitiveRestoreFee;
        totalEffectiveFee += restoreTxMeta.effectiveFeeCharged;
        this.pendingReservations.delete(activeRestoreHash);
        this.persistDurableReservations();
      } catch (err: any) {
        // Track committed fee on failure:
        // Always preserve the maximum committed envelope fee for cycle budget safety,
        // but record the EXACT effective fee charged if extracted from FAILED transaction resultXdr!
        err.committedFeeStroops = definitiveRestoreFee;
        err.effectiveFeeStroops = (err && typeof err.effectiveFeeCharged === "bigint") ? err.effectiveFeeCharged : definitiveRestoreFee;
        this.persistDurableReservations();
        throw err;
      }

      // Re-fetch sequence and re-simulate invocation wrapped in try-catch to preserve committed restoration fee
      let freshSim: rpc.Api.SimulateTransactionResponse;
      let freshTx: any;
      try {
        const freshAccount = await this.server.getAccount(this.sponsorKey.publicKey());
        freshTx = new TransactionBuilder(freshAccount, {
          fee: baseInclusionFee.toString(),
          networkPassphrase: this.config.networkPassphrase,
        })
          .addOperation(poolContract.call(method, ...args))
          .setTimeout(30)
          .build();
        freshSim = await this.server.simulateTransaction(freshTx);
        if (rpc.Api.isSimulationError(freshSim)) {
          throw new Error(`Re-simulation after restoration failed: ${freshSim.error}`);
        }
        if (freshSim.restorePreamble && freshSim.restorePreamble.minResourceFee) {
          throw new Error("Re-simulation unexpectedly required second restoration preamble");
        }
        const freshTxBuilder = rpc.assembleTransaction(freshTx, freshSim);
        if (freshSim.minResourceFee) {
          const rawData =
            freshSim.transactionData && typeof (freshSim.transactionData as any).build === "function"
              ? (freshSim.transactionData as any).build()
              : freshSim.transactionData;
          const sorobanDataBuilder = new SorobanDataBuilder(rawData);
          sorobanDataBuilder.setResourceFee(freshSim.minResourceFee);
          freshTxBuilder.setSorobanData(sorobanDataBuilder.build());
        }
        preparedTx = freshTxBuilder.build();
      } catch (postRestoreErr: any) {
        postRestoreErr.committedFeeStroops = totalCommittedFee;
        postRestoreErr.effectiveFeeStroops = totalEffectiveFee;
        throw postRestoreErr;
      }
    }

    let txConfirmedResult: { effectiveFeeCharged: bigint; returnValue?: xdr.ScVal; resultMetaXdr?: any };
    let sendRes: rpc.Api.SendTransactionResponse;
    let definitiveEnvelopeFee = 0n;

    try {
      // 3. Strict definitive envelope budget check & per-tx fee policy on invocation:
      definitiveEnvelopeFee = BigInt(preparedTx.fee);
      if (definitiveEnvelopeFee > maxFeeLimit) {
        throw new Error(
          `Envelope fee exceeds maximum allowable per-transaction policy: fee ${definitiveEnvelopeFee} > maxFeeLimit ${maxFeeLimit}`
        );
      }

      // STRICT PRE-FLIGHT CYCLE BUDGET: Verify total combined fee (restoration + invocation) fits remainingBudget
      if (remainingBudget !== undefined && totalCommittedFee + definitiveEnvelopeFee > remainingBudget) {
        throw new Error(
          `Total combined claim fee exceeds remaining cycle budget: combined ${totalCommittedFee + definitiveEnvelopeFee} > remaining ${remainingBudget}`
        );
      }

      const preSendSolvency = await this.checkSponsorSolvency();
      if (preSendSolvency.availableStroops < definitiveEnvelopeFee + this.config.minSponsorReserveStroops) {
        throw new Error(
          `Insufficient sponsor balance for assembled invocation: available ${preSendSolvency.availableStroops} < required ${definitiveEnvelopeFee + this.config.minSponsorReserveStroops} (fee: ${definitiveEnvelopeFee}, reserve: ${this.config.minSponsorReserveStroops})`
        );
      }

      preparedTx.sign(this.sponsorKey);
      const computedTxHash = preparedTx.hash().toString("hex");

      // WAL (Write-Ahead Logging): Persist reservation BEFORE dispatching to network.
      // This strictly closes the crash window: if the process crashes during or immediately
      // after sendTransaction, the reservation is already durably on disk upon reboot.
      this.pendingReservations.set(computedTxHash, {
        txHash: computedTxHash,
        committedFeeStroops: definitiveEnvelopeFee,
        timestamp: Date.now(),
      });
      this.persistDurableReservations();

      try {
        sendRes = await this.server.sendTransaction(preparedTx);
      } catch (transportErr: any) {
        transportErr.committedFeeStroops = totalCommittedFee + definitiveEnvelopeFee;
        transportErr.effectiveFeeStroops = totalEffectiveFee + definitiveEnvelopeFee;
        throw transportErr;
      }

      if (sendRes.status === "ERROR") {
        this.pendingReservations.delete(computedTxHash);
        this.persistDurableReservations();
        throw new Error(`Transaction submission error: ${sendRes.errorResult?.toXDR("base64")}`);
      }

      // If the RPC returned a hash that matches or differs (e.g. envelope hash vs hash), update mapping
      if (sendRes.hash && sendRes.hash !== computedTxHash) {
        this.pendingReservations.delete(computedTxHash);
        this.pendingReservations.set(sendRes.hash, {
          txHash: sendRes.hash,
          committedFeeStroops: definitiveEnvelopeFee,
          timestamp: Date.now(),
        });
        this.persistDurableReservations();
      }

      const activeHash = sendRes.hash || computedTxHash;

      try {
        txConfirmedResult = await this.waitForConfirmation(activeHash);
        totalCommittedFee += definitiveEnvelopeFee;
        totalEffectiveFee += txConfirmedResult.effectiveFeeCharged;
        // Cleanly remove from pendingReservations upon confirmed execution
        this.pendingReservations.delete(activeHash);
        this.persistDurableReservations();
      } catch (confirmErr: any) {
        confirmErr.committedFeeStroops = totalCommittedFee + definitiveEnvelopeFee;
        confirmErr.effectiveFeeStroops = totalEffectiveFee + ((confirmErr && typeof confirmErr.effectiveFeeCharged === "bigint") ? confirmErr.effectiveFeeCharged : definitiveEnvelopeFee);
        // Retain in pendingReservations across timeout so subsequent cycles deduct it
        this.persistDurableReservations();
        throw confirmErr;
      }
    } catch (postRestoreFlowErr: any) {
      if (postRestoreFlowErr.committedFeeStroops === undefined) {
        postRestoreFlowErr.committedFeeStroops = totalCommittedFee;
      }
      if (postRestoreFlowErr.effectiveFeeStroops === undefined) {
        postRestoreFlowErr.effectiveFeeStroops = totalEffectiveFee;
      }
      throw postRestoreFlowErr;
    }

    const confirmedPayout = this.parseScValAmount(txConfirmedResult.returnValue);

    return {
      txHash: sendRes.hash,
      committedFeeStroops: totalCommittedFee,
      effectiveFeeStroops: totalEffectiveFee,
      feeSpentStroops: totalEffectiveFee,
      payoutStroops: confirmedPayout,
      resultMetaXdr: txConfirmedResult.resultMetaXdr,
    };
  }

  /**
   * Extract tranchesAdvanced from transaction meta events if claim_sec event is found.
   * Supports both TransactionMetaV3 and TransactionMetaV4, filtering strictly by contract ID,
   * contract event type, topic symbol ("claim_sec"), and matching investor address.
   */
  public extractTranchesAdvancedFromMeta(
    resultMetaXdr: any,
    expectedContractId?: string,
    expectedInvestor?: string
  ): number | null {
    if (!resultMetaXdr) return null;
    try {
      const meta = typeof resultMetaXdr === "string"
        ? xdr.TransactionMeta.fromXDR(resultMetaXdr, "base64")
        : resultMetaXdr;

      const arm = typeof meta.arm === "function" ? meta.arm() : null;
      const switchVal = typeof meta.switch === "function" ? meta.switch() : null;
      let events: any[] | null = null;

      if (arm === "v3" || switchVal === 3) {
        const sorobanMeta = meta.v3().sorobanMeta();
        if (sorobanMeta) {
          events = sorobanMeta.events();
        }
      } else if (arm === "v4" || switchVal === 4) {
        // In TransactionMetaV4, contract events are strictly located in operations[].events (OperationMetaV2)
        const ops = meta.v4().operations();
        if (ops && ops.length > 0) {
          events = [];
          for (const op of ops) {
            if (op && typeof op.events === "function") {
              const opEvents = op.events();
              if (opEvents && opEvents.length > 0) {
                events.push(...opEvents);
              }
            }
          }
        }
      }

      if (!events || events.length === 0) return null;

      let totalTranchesFound = 0;
      let matchingEventsCount = 0;

      for (const ev of events) {
        try {
          if (ev.type && ev.type().value !== xdr.ContractEventType.contract().value) {
            continue;
          }

          if (expectedContractId && ev.contractId()) {
            const evContractId = StrKey.encodeContract(ev.contractId());
            if (evContractId !== expectedContractId) continue;
          }

          const v0 = ev.body().v0();
          const topics = v0.topics();
          if (!topics || topics.length < 2) continue;

          let sym = null;
          try {
            sym = topics[0].sym ? topics[0].sym().toString() : null;
          } catch (e) {
            if (topics[0].switch().name === "scvSymbol") {
              sym = topics[0].sym().toString();
            }
          }
          if (sym !== "claim_sec") continue;

          if (expectedInvestor) {
            const invNative = Address.fromScVal(topics[1]).toString();
            if (invNative !== expectedInvestor) continue;
          }

          const dataVal = v0.data();
          if (dataVal.switch().name === "scvVec" || dataVal.switch().value === xdr.ScValType.scvVec().value) {
            const vec = dataVal.vec();
            if (vec && vec.length >= 2) {
              const start = vec[0].u32();
              const end = vec[1].u32();
              if (end >= start) {
                totalTranchesFound += (end - start + 1);
                matchingEventsCount++;
              }
            }
          }
        } catch (inner) {}
      }

      return matchingEventsCount > 0 ? totalTranchesFound : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Poll RPC getTransaction with monotonic wall-clock deadline, abort signal for individual RPC calls,
   * timer cleanup, and post-verification to strictly reject late responses.
   * Returns exact on-chain feeCharged, returnValue, and resultMetaXdr.
   */
  private async waitForConfirmation(
    txHash: string
  ): Promise<{ effectiveFeeCharged: bigint; returnValue?: xdr.ScVal; resultMetaXdr?: any }> {
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
          let feeCharged = 0n;
          if (res.resultXdr) {
            try {
              feeCharged = res.resultXdr.feeCharged().toBigInt();
            } catch (e) {
              feeCharged = BigInt(res.resultXdr.feeCharged().toString());
            }
          }
          return {
            effectiveFeeCharged: feeCharged,
            returnValue: (res as any).returnValue,
            resultMetaXdr: (res as any).resultMetaXdr,
          };
        }
        if (res.status === "FAILED") {
          let feeCharged = 0n;
          if (res.resultXdr) {
            try {
              feeCharged = res.resultXdr.feeCharged().toBigInt();
            } catch (e) {
              feeCharged = BigInt(res.resultXdr.feeCharged().toString());
            }
          }
          const failedErr: any = new Error(`Transaction ${txHash} execution failed on-chain`);
          failedErr.effectiveFeeCharged = feeCharged;
          throw failedErr;
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
