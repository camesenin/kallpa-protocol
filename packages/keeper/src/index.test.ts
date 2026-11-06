import { describe, expect, it } from "bun:test";
import { KallpaKeeperDaemon, ClaimPayoutType, type KeeperConfig } from "./index";
import { Keypair, xdr, Address, SorobanDataBuilder } from "@stellar/stellar-sdk";

describe("@kallpa/keeper", () => {
  const dummyKey = Keypair.random();
  const dummyConfig: KeeperConfig = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    sponsorSecret: dummyKey.secret(),
    poolContractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4"],
    maxTranchesPerBatch: 25,
    minSponsorReserveStroops: 50_000_000n, // 5 XLM
    maxFeePerTxStroops: 2_000_000n, // 0.2 XLM
    maxSweepBudgetStroops: 10_000_000n, // 1 XLM
    maxZeroPayoutTranchesPerCycle: 5,
  };

  it("initializes successfully with valid configuration", () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    expect(daemon).toBeDefined();
  });

  it("strictly validates maxTranches: rejects non-integers, out-of-bounds, negative or NaN", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    const mockContract = {} as any;

    expect(daemon.disburseSecondaryRecovery(mockContract, "GAAA", 1.5)).rejects.toThrow(
      "Must be an integer between 1 and 50"
    );

    expect(daemon.disburseSecondaryRecovery(mockContract, "GAAA", 0)).rejects.toThrow(
      "Must be an integer between 1 and 50"
    );

    expect(daemon.disburseSecondaryRecovery(mockContract, "GAAA", 51)).rejects.toThrow(
      "Must be an integer between 1 and 50"
    );

    expect(daemon.disburseSecondaryRecovery(mockContract, "GAAA", -5)).rejects.toThrow(
      "Must be an integer between 1 and 50"
    );

    expect(daemon.disburseSecondaryRecovery(mockContract, "GAAA", NaN)).rejects.toThrow(
      "Must be an integer between 1 and 50"
    );
  });

  it("short-circuits when secondary recovery is fully exhausted (total <= claimed)", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);

    const { Account, Contract } = await import("@stellar/stellar-sdk");
    const mockAccount = new Account(dummyKey.publicKey(), "100");

    // Mock get_secondary_claim_status returning tuple (25, 25) -> fully claimed!
    const exhaustedStatusVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvU32(25),
      xdr.ScVal.scvU32(25),
    ]);

    (daemon as any).server = {
      getAccount: async () => mockAccount,
      simulateTransaction: async () => ({
        result: { retval: exhaustedStatusVal },
      }),
    };

    const dummyPool = new Contract("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4");
    const dummyInvestorVal = new Address(dummyKey.publicKey()).toScVal();

    const isExhausted = await daemon.isSecondaryClaimExhausted(dummyPool, dummyInvestorVal);
    expect(isExhausted).toBe(true);

    // executePermissionlessCall must short-circuit without network submission
    let sendTxCalled = false;
    (daemon as any).server.sendTransaction = async () => {
      sendTxCalled = true;
      return { status: "SUCCESS", hash: "mockHash" };
    };

    const receipt = await daemon.disburseSecondaryRecoveryWithReceipt(dummyPool, dummyKey.publicKey(), 10);
    expect(receipt.txHash).toBeNull();
    expect(receipt.feeSpentStroops).toBe(0n);
    expect(receipt.committedFeeStroops).toBe(0n);
    expect(receipt.effectiveFeeStroops).toBe(0n);
    expect(sendTxCalled).toBe(false);
  });

  it("does NOT short-circuit when secondary recovery has unvisited tranches (total > claimed) even if payout is zero", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);

    const { Account, Contract } = await import("@stellar/stellar-sdk");
    const mockAccount = new Account(dummyKey.publicKey(), "100");

    // Mock get_secondary_claim_status returning (25, 10) -> 15 unvisited tranches!
    const activeStatusVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvU32(25),
      xdr.ScVal.scvU32(10),
    ]);

    let sentTx = false;
    (daemon as any).server = {
      getAccount: async () => mockAccount,
      simulateTransaction: async () => ({
        minResourceFee: "1000",
        results: [{ auth: [], xdr: null }],
        transactionData: new SorobanDataBuilder().build(),
        result: { retval: activeStatusVal },
      }),
      sendTransaction: async () => {
        sentTx = true;
        return { status: "SUCCESS", hash: "txHashProgress" };
      },
      getTransaction: async () => ({
        status: "SUCCESS",
        resultXdr: {
          feeCharged: () => ({ toBigInt: () => 101000n, toString: () => "101000" }),
        },
      }),
    };

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    const dummyPool = new Contract("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4");
    const receipt = await daemon.disburseSecondaryRecoveryWithReceipt(dummyPool, dummyKey.publicKey(), 10);

    // Transaction MUST have been submitted to advance the cursor!
    expect(sentTx).toBe(true);
    expect(receipt.txHash).toBe("txHashProgress");
  });

  it("enforces maxFeePerTxStroops policy: rejects envelopes exceeding per-tx budget", async () => {
    const daemon = new KallpaKeeperDaemon({
      ...dummyConfig,
      maxFeePerTxStroops: 500_000n, // 0.05 XLM cap
    });

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    const { Account, Contract } = await import("@stellar/stellar-sdk");
    const mockAccount = new Account(dummyKey.publicKey(), "100");

    (daemon as any).server = {
      getAccount: async () => mockAccount,
      simulateTransaction: async () => ({
        minResourceFee: "600000", // Requires 600k fee, exceeding 500k cap!
        results: [{ auth: [], xdr: null }],
        transactionData: new SorobanDataBuilder().setResourceFee(600000).build(),
      }),
    };

    const dummyPool = new Contract("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4");
    expect(
      daemon.disburseClaimReturnWithReceipt(dummyPool, dummyKey.publicKey())
    ).rejects.toThrow("Envelope fee exceeds maximum allowable per-transaction policy");
  });

  it("strictly enforces that next transaction does not exceed remaining sweep budget (e.g. 300k budget with 200k tx stops at 1 tx)", async () => {
    const tightConfig: KeeperConfig = {
      ...dummyConfig,
      maxSweepBudgetStroops: 300_000n, // Strict 300k budget
      maxFeePerTxStroops: 250_000n,
    };
    const daemon = new KallpaKeeperDaemon(tightConfig);
    const poolId = tightConfig.poolContractIds[0];

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    let callCount = 0;
    (daemon as any).disburseClaimReturnWithReceipt = async (
      _contract: any,
      _investor: any,
      remainingBudget: bigint
    ) => {
      const fee = 200_000n;
      if (fee > remainingBudget) {
        throw new Error(`Total combined claim fee exceeds remaining cycle budget: combined ${fee} > remaining ${remainingBudget}`);
      }
      callCount++;
      return { txHash: "mockHash" + callCount, feeSpentStroops: fee, committedFeeStroops: fee, effectiveFeeStroops: fee, payoutStroops: 1000n };
    };

    const targets = new Map([
      [
        poolId,
        [
          { investor: Keypair.random().publicKey(), action: "claim_return" as const },
          { investor: Keypair.random().publicKey(), action: "claim_return" as const },
        ],
      ],
    ]);

    const result = await daemon.runSweepCycle(targets);
    // First tx spent 200k. Second tx requires 200k but remaining budget is only 100k (300k - 200k).
    // Second tx fails pre-flight budget check and is caught without exceeding the 300k ceiling!
    expect(callCount).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.totalFeeSpentStroops).toBe(200_000n);
    expect(result.totalFeeSpentStroops <= 300_000n).toBe(true);
  });

  it("accurately counts confirmed zero payout advancements vs exhausted skips", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    const poolId = dummyConfig.poolContractIds[0];

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    daemon.isSecondaryClaimExhausted = async () => false;
    daemon.getSecondaryClaimStatus = async () => ({ total: 100, claimed: 0, remaining: 100 });

    (daemon as any).disburseSecondaryRecoveryWithReceipt = async (
      _contract: any,
      _investor: any,
      _tranches: number,
      _remaining: bigint
    ) => {
      // Confirmed on-chain advancement with 0 payout
      return {
        txHash: "mockHashAdvancement",
        committedFeeStroops: 100_000n,
        effectiveFeeStroops: 100_000n,
        feeSpentStroops: 100_000n,
        payoutStroops: 0n,
      };
    };

    const targets = new Map([
      [
        poolId,
        [
          { investor: Keypair.random().publicKey(), action: "claim_secondary" as const, maxTranches: 1 },
          { investor: Keypair.random().publicKey(), action: "claim_secondary" as const, maxTranches: 1 },
        ],
      ],
    ]);

    const result = await daemon.runSweepCycle(targets);
    expect(result.processed).toBe(2);
    expect(result.confirmedZeroPayoutAdvancements).toBe(2);
    expect(result.skippedExhausted).toBe(0);
    expect(result.totalFeeSpentStroops).toBe(200_000n);
  });

  it("preserves committed restoration fees across post-restoration failures and transport errors", async () => {
    const tightConfig: KeeperConfig = {
      ...dummyConfig,
      maxSweepBudgetStroops: 300_000n,
    };
    const daemon = new KallpaKeeperDaemon(tightConfig);
    const poolId = tightConfig.poolContractIds[0];

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    const { Account, Contract } = await import("@stellar/stellar-sdk");
    const mockAccount = new Account(dummyKey.publicKey(), "100");

    let restoreCallCount = 0;
    (daemon as any).server = {
      getAccount: async () => mockAccount,
      simulateTransaction: async () => {
        // Return restore preamble
        return {
          minResourceFee: "50000",
          results: [{ auth: [], xdr: null }],
          transactionData: new SorobanDataBuilder().build(),
          restorePreamble: {
            minResourceFee: "100000", // 100k restoration fee
            transactionData: new SorobanDataBuilder().build(),
          },
        };
      },
      sendTransaction: async () => {
        restoreCallCount++;
        return { status: "SUCCESS", hash: "restoreHash123" };
      },
      getTransaction: async () => ({
        status: "SUCCESS",
        resultXdr: {
          feeCharged: () => ({ toBigInt: () => 100000n, toString: () => "100000" }),
        },
      }),
    };

    // Override waitForConfirmation to simulate successful restore, but then make re-simulation fail!
    let firstConfirmation = true;
    (daemon as any).waitForConfirmation = async (_hash: string) => {
      if (firstConfirmation) {
        firstConfirmation = false;
        return { effectiveFeeCharged: 100000n };
      }
      return { effectiveFeeCharged: 50000n };
    };

    // Break server.simulateTransaction on second call (post-restoration re-simulation)
    let simCount = 0;
    const origSim = (daemon as any).server.simulateTransaction;
    (daemon as any).server.simulateTransaction = async (tx: any) => {
      simCount++;
      if (simCount === 2) {
        return { error: "Simulated RPC failure during re-simulation after restoration" };
      }
      return origSim(tx);
    };

    const realContract = new Contract(poolId);
    let capturedErr: any = null;
    try {
      await (daemon as any).executePermissionlessCall(
        realContract,
        "claim_return",
        [new Address(Keypair.random().publicKey()).toScVal()],
        250000n
      );
    } catch (err: any) {
      capturedErr = err;
    }

    expect(capturedErr).toBeDefined();
    // CRITICAL: The committedFeeStroops must NOT be lost!
    expect(capturedErr.committedFeeStroops).toBe(200000n); // 100k base + 100k resource
    expect(capturedErr.effectiveFeeStroops).toBe(100000n);
  });

  it("evaluates next claim after reaching maxZeroPayouts and processes positive payout without blocking", async () => {
    const daemon = new KallpaKeeperDaemon({
      ...dummyConfig,
      maxZeroPayoutTranchesPerCycle: 1, // Only 1 zero payout tranche allowed
    });
    const poolId = dummyConfig.poolContractIds[0];

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    daemon.isSecondaryClaimExhausted = async () => false;
    daemon.getSecondaryClaimStatus = async () => ({ total: 100, claimed: 0, remaining: 100 });

    const investor1 = Keypair.random().publicKey();
    const investor2 = Keypair.random().publicKey();

    // Investor 1 is simulated with 0 payout; Investor 2 is simulated with positive 5000 payout
    (daemon as any).isClaimZeroPayout = async (_contract: any, _method: string, args: any[]) => {
      const invAddr = Address.fromScVal(args[0]).toString();
      return invAddr === investor1 ? ClaimPayoutType.Zero : ClaimPayoutType.Positive;
    };

    let processedInvestors: string[] = [];
    (daemon as any).disburseSecondaryRecoveryWithReceipt = async (
      _contract: any,
      investor: string,
      _tranches: number,
      _remaining: bigint
    ) => {
      processedInvestors.push(investor);
      const payout = investor === investor1 ? 0n : 5000n;
      return {
        txHash: "mockHash_" + investor,
        committedFeeStroops: 100000n,
        effectiveFeeStroops: 80000n,
        feeSpentStroops: 80000n,
        payoutStroops: payout,
      };
    };

    const targets = new Map([
      [
        poolId,
        [
          { investor: investor1, action: "claim_secondary" as const, maxTranches: 1 }, // zero payout -> reaches maxZeroPayouts limit of 1 tranche
          { investor: investor1, action: "claim_secondary" as const, maxTranches: 1 }, // zero payout -> MUST be skipped
          { investor: investor2, action: "claim_secondary" as const, maxTranches: 1 }, // positive payout -> MUST NOT be blocked!
        ],
      ],
    ]);

    const result = await daemon.runSweepCycle(targets);
    // investor1 executed once (count = 1), second investor1 skipped, investor2 executed (positive payout!)
    expect(processedInvestors).toContain(investor1);
    expect(processedInvestors).toContain(investor2);
    expect(result.processed).toBe(2);
    expect(result.confirmedZeroPayoutAdvancements).toBe(1);
  });

  it("contrasts simulated fee reservation against exact on-chain fee charged from confirmed execution", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    const poolId = dummyConfig.poolContractIds[0];

    const { Account, Contract } = await import("@stellar/stellar-sdk");
    const mockAccount = new Account(dummyKey.publicKey(), "100");

    (daemon as any).server = {
      getAccount: async () => mockAccount,
      simulateTransaction: async () => ({
        minResourceFee: "100000",
        results: [{ auth: [], xdr: null, retval: xdr.ScVal.scvI128(new xdr.Int128Parts({ lo: xdr.Uint64.fromString("100"), hi: xdr.Int64.fromString("0") })) }],
        transactionData: new SorobanDataBuilder().setResourceFee(100000).build(),
      }),
      sendTransaction: async () => ({ status: "SUCCESS", hash: "testExactFeeHash" }),
      getTransaction: async () => ({
        status: "SUCCESS",
        resultXdr: {
          feeCharged: () => ({ toBigInt: () => 123456n, toString: () => "123456" }),
        },
        returnValue: xdr.ScVal.scvI128(new xdr.Int128Parts({ lo: xdr.Uint64.fromString("5000"), hi: xdr.Int64.fromString("0") })),
      }),
    };

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    const realContract = new Contract(poolId);
    const receipt = await daemon.disburseClaimReturnWithReceipt(realContract, Keypair.random().publicKey(), 1000000n);

    // Max committed envelope fee reserved was 200,000 stroops
    expect(receipt.committedFeeStroops).toBe(200000n);
    // Exact fee charged confirmed on-chain was 123,456 stroops
    expect(receipt.effectiveFeeStroops).toBe(123456n);
    // Confirmed on-chain payout was 5,000 stroops (reconciled over simulation)
    expect(receipt.payoutStroops).toBe(5000n);
  });

  it("regression: post-restoration checkSponsorSolvency failure preserves committed restoration fee and prevents budget breach", async () => {
    const tightConfig: KeeperConfig = {
      ...dummyConfig,
      maxSweepBudgetStroops: 300_000n, // Strict 300k cycle budget
    };
    const daemon = new KallpaKeeperDaemon(tightConfig);
    const poolId = tightConfig.poolContractIds[0];

    const { Account, Contract } = await import("@stellar/stellar-sdk");
    const mockAccount = new Account(dummyKey.publicKey(), "100");

    let restoreSent = false;
    (daemon as any).server = {
      getAccount: async () => mockAccount,
      simulateTransaction: async () => ({
        minResourceFee: "50000",
        results: [{ auth: [], xdr: null }],
        transactionData: new SorobanDataBuilder().build(),
        restorePreamble: {
          minResourceFee: "100000", // 100k restoration fee (total envelope 200k)
          transactionData: new SorobanDataBuilder().build(),
        },
      }),
      sendTransaction: async () => {
        restoreSent = true;
        return { status: "SUCCESS", hash: "restoreTxSolvencyLeakHash" };
      },
      getTransaction: async () => ({
        status: "SUCCESS",
        resultXdr: {
          feeCharged: () => ({ toBigInt: () => 100000n, toString: () => "100000" }),
        },
      }),
    };

    // Restoration succeeds and is confirmed on-chain for 100k fee (200k envelope committed)
    (daemon as any).waitForConfirmation = async () => ({ effectiveFeeCharged: 100000n });

    // Mock checkSponsorSolvency: succeeds for pre-restoration, then THROWS during post-restoration check!
    let solvencyCalls = 0;
    daemon.checkSponsorSolvency = async () => {
      solvencyCalls++;
      if (solvencyCalls >= 2) {
        throw new Error("Simulated RPC transport network outage during post-restoration checkSponsorSolvency");
      }
      return {
        solvent: true,
        balanceStroops: 100_000_000n,
        availableStroops: 80_000_000n,
      };
    };

    const realContract = new Contract(poolId);
    let capturedErr: any = null;
    try {
      await (daemon as any).executePermissionlessCall(
        realContract,
        "claim_return",
        [new Address(Keypair.random().publicKey()).toScVal()],
        300000n
      );
    } catch (err: any) {
      capturedErr = err;
    }

    expect(restoreSent).toBe(true);
    expect(capturedErr).toBeDefined();
    // Critical: error must carry totalCommittedFee (200k) and totalEffectiveFee (100k)
    expect(capturedErr.committedFeeStroops).toBe(200000n);
    expect(capturedErr.effectiveFeeStroops).toBe(100000n);
  });

  it("regression: ternary ClaimPayoutType.Unknown skips claim when zero-payout budget exhausted", async () => {
    const daemon = new KallpaKeeperDaemon({
      ...dummyConfig,
      maxZeroPayoutTranchesPerCycle: 1, // Max 1 zero payout allowed
    });
    const poolId = dummyConfig.poolContractIds[0];

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });
    daemon.isSecondaryClaimExhausted = async () => false;
    daemon.getSecondaryClaimStatus = async () => ({ total: 100, claimed: 0, remaining: 100 });

    const investor1 = Keypair.random().publicKey();
    const investorUnknown = Keypair.random().publicKey();

    (daemon as any).isClaimZeroPayout = async (_c: any, _m: string, args: any[]) => {
      const invAddr = Address.fromScVal(args[0]).toString();
      if (invAddr === investor1) return ClaimPayoutType.Zero;
      // Simulation fails / errors for investorUnknown -> Unknown!
      return ClaimPayoutType.Unknown;
    };

    let processedCount = 0;
    (daemon as any).disburseSecondaryRecoveryWithReceipt = async () => {
      processedCount++;
      return {
        txHash: "mockHash",
        committedFeeStroops: 100000n,
        effectiveFeeStroops: 80000n,
        feeSpentStroops: 80000n,
        payoutStroops: 0n,
      };
    };

    const targets = new Map([
      [
        poolId,
        [
          { investor: investor1, action: "claim_secondary" as const, maxTranches: 1 }, // Reaches max 1 zero payout
          { investor: investorUnknown, action: "claim_secondary" as const, maxTranches: 1 }, // Unknown MUST be skipped!
        ],
      ],
    ]);

    const result = await daemon.runSweepCycle(targets);
    // Only investor1 processed; investorUnknown was safely skipped due to Unknown status
    expect(result.processed).toBe(1);
    expect(processedCount).toBe(1);
  });

  it("regression: waitForConfirmation attaches effectiveFeeCharged from resultXdr on FAILED transaction", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);

    (daemon as any).server = {
      getTransaction: async () => ({
        status: "FAILED",
        resultXdr: {
          feeCharged: () => ({ toBigInt: () => 145000n, toString: () => "145000" }),
        },
      }),
    };

    let failedErr: any = null;
    try {
      await (daemon as any).waitForConfirmation("failedTxHash123");
    } catch (e: any) {
      failedErr = e;
    }

    expect(failedErr).toBeDefined();
    expect(failedErr.message).toContain("execution failed on-chain");
    expect(failedErr.effectiveFeeCharged).toBe(145000n);
  });
  it("regression: pre-flight quota reservation blocks batch when batch advancement exceeds remaining zero-payout quota", async () => {
    const daemon = new KallpaKeeperDaemon({
      ...dummyConfig,
      maxZeroPayoutTranchesPerCycle: 1, // Only 1 zero-payout tranche allowed
    });
    const poolId = dummyConfig.poolContractIds[0];

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    const investor = Keypair.random().publicKey();
    // Investor has 50 remaining tranches
    daemon.getSecondaryClaimStatus = async () => ({
      total: 100,
      claimed: 50,
      remaining: 50,
    });

    // Simulated payout is 0 (Zero payout)
    daemon.isClaimZeroPayout = async () => ClaimPayoutType.Zero;

    let disburseCalled = false;
    (daemon as any).disburseSecondaryRecoveryWithReceipt = async () => {
      disburseCalled = true;
      return {
        txHash: "mockHash",
        committedFeeStroops: 100000n,
        effectiveFeeStroops: 80000n,
        feeSpentStroops: 80000n,
        payoutStroops: 0n,
      };
    };

    // Target requests batch of 50 tranches. Remaining quota is 1.
    // Pre-flight quota check must reject the batch BEFORE dispatch!
    const targets = new Map([
      [
        poolId,
        [{ investor, action: "claim_secondary" as const, maxTranches: 50 }],
      ],
    ]);

    const result = await daemon.runSweepCycle(targets);
    expect(disburseCalled).toBe(false);
    expect(result.processed).toBe(0);
    expect(result.confirmedZeroPayoutAdvancements).toBe(0);
  });

  it("regression: preserves exact effectiveFeeCharged on FAILED restoration transaction", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    const poolId = dummyConfig.poolContractIds[0];

    const { Account, Contract } = await import("@stellar/stellar-sdk");
    const mockAccount = new Account(dummyKey.publicKey(), "100");

    (daemon as any).server = {
      getAccount: async () => mockAccount,
      simulateTransaction: async () => ({
        minResourceFee: "50000",
        results: [{ auth: [], xdr: null }],
        transactionData: new SorobanDataBuilder().build(),
        restorePreamble: {
          minResourceFee: "100000", // 100k restoration fee (definitive fee 200k)
          transactionData: new SorobanDataBuilder().build(),
        },
      }),
      sendTransaction: async () => ({ status: "SUCCESS", hash: "restoreFailedHash" }),
    };

    // Restoration transaction confirmed as FAILED on-chain, charging exact 145,000 stroops
    const failedErr: any = new Error("Transaction restoreFailedHash execution failed on-chain");
    failedErr.effectiveFeeCharged = 145000n;
    (daemon as any).waitForConfirmation = async () => {
      throw failedErr;
    };

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    const realContract = new Contract(poolId);
    let capturedErr: any = null;
    try {
      await (daemon as any).executePermissionlessCall(
        realContract,
        "claim_return",
        [new Address(Keypair.random().publicKey()).toScVal()],
        300000n
      );
    } catch (err: any) {
      capturedErr = err;
    }

    expect(capturedErr).toBeDefined();
    // committedFeeStroops preserves the 200k ceiling reservation
    expect(capturedErr.committedFeeStroops).toBe(200000n);
    // effectiveFeeStroops reflects the EXACT fee charged by Stellar Core (145k), NOT the 200k ceiling!
    expect(capturedErr.effectiveFeeStroops).toBe(145000n);
  });
  it("reconciles exact on-chain tranche advancement when external state changes occur between pre-query and execution", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    const { Contract } = await import("@stellar/stellar-sdk");
    const pool = new Contract(dummyConfig.poolContractIds[0]);
    const investor = Keypair.random().publicKey();

    let queryCount = 0;
    daemon.getSecondaryClaimStatus = async () => {
      queryCount++;
      if (queryCount === 1) {
        // Pre-query: 100 total, 0 claimed, 100 remaining
        return { total: 100, claimed: 0, remaining: 100 };
      }
      // Post-confirmation state: an external concurrent actor advanced 8 tranches, our tx advanced 2 -> 10 claimed!
      return { total: 100, claimed: 10, remaining: 90 };
    };

    (daemon as any).executePermissionlessCall = async () => ({
      txHash: "concurrentTxHash",
      feeSpentStroops: 100000n,
      committedFeeStroops: 100000n,
      effectiveFeeStroops: 100000n,
      payoutStroops: 0n,
    });

    const receipt = await daemon.disburseSecondaryRecoveryWithReceipt(pool, investor, 50);
    // Must record EXACT on-chain state delta (10 - 0 = 10), NOT the raw expected 50!
    expect(receipt.tranchesAdvanced).toBe(10);
    expect(queryCount).toBe(2);
  });
  it("executes complete 4-step restoration and invocation lifecycle: sim with preamble -> restore -> clean re-sim -> confirmed execution", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    const poolId = dummyConfig.poolContractIds[0];

    const { Account, Contract } = await import("@stellar/stellar-sdk");
    const mockAccount = new Account(dummyKey.publicKey(), "100");

    let simCalls = 0;
    let restoreTxSent = false;
    let invocationTxSent = false;

    (daemon as any).server = {
      getAccount: async () => mockAccount,
      simulateTransaction: async () => {
        simCalls++;
        if (simCalls === 1) {
          // Step 1: Initial simulation indicates archived footprint requiring restoration
          return {
            minResourceFee: "50000",
            results: [{ auth: [], xdr: null }],
            transactionData: new SorobanDataBuilder().build(),
            restorePreamble: {
              minResourceFee: "100000",
              transactionData: new SorobanDataBuilder().build(),
            },
          };
        }
        // Step 3: Clean post-restoration re-simulation WITHOUT restorePreamble!
        return {
          minResourceFee: "50000",
          results: [{ auth: [], xdr: null }],
          transactionData: new SorobanDataBuilder().build(),
        };
      },
      sendTransaction: async (tx: any) => {
        if (!restoreTxSent) {
          restoreTxSent = true;
          return { status: "SUCCESS", hash: "restoreTxConfirmedHash" };
        }
        invocationTxSent = true;
        return { status: "SUCCESS", hash: "invocationConfirmedHash" };
      },
      getTransaction: async () => ({
        status: "SUCCESS",
        resultXdr: {
          feeCharged: () => ({ toBigInt: () => 100000n, toString: () => "100000" }),
        },
      }),
    };

    (daemon as any).waitForConfirmation = async (hash: string) => ({
      effectiveFeeCharged: hash === "restoreTxConfirmedHash" ? 100000n : 105000n,
    });

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    const realContract = new Contract(poolId);
    const receipt = await (daemon as any).executePermissionlessCall(
      realContract,
      "claim_return",
      [new Address(Keypair.random().publicKey()).toScVal()]
    );

    // Assert that the exact 4-step sequence executed:
    // 1. Initial simulation returning restorePreamble
    // 2. Standalone restoreFootprint transaction sent and confirmed
    // 3. Clean re-simulation without restorePreamble
    // 4. Invocation transaction dispatched and confirmed
    expect(simCalls).toBe(2);
    expect(restoreTxSent).toBe(true);
    expect(invocationTxSent).toBe(true);
    expect(receipt.txHash).toBe("invocationConfirmedHash");
    // Restoration (100k) + Invocation (105k) = 205k total effective fee
    expect(receipt.effectiveFeeStroops).toBe(205000n);
  });
  it("strictly rejects concurrent sweep cycle dispatches on the same keeper instance", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    const poolId = dummyConfig.poolContractIds[0];

    daemon.checkSponsorSolvency = async () => ({
      solvent: true,
      balanceStroops: 100_000_000n,
      availableStroops: 80_000_000n,
    });

    // Mock long-running execution for first cycle
    let resolveFirstCycle: () => void = () => {};
    const firstCycleWait = new Promise<void>((r) => {
      resolveFirstCycle = r;
    });

    (daemon as any).disburseClaimReturnWithReceipt = async () => {
      await firstCycleWait;
      return { txHash: "mockTxHash", feeSpentStroops: 100000n, committedFeeStroops: 100000n, effectiveFeeStroops: 100000n, payoutStroops: 1000n };
    };

    const targets = new Map([
      [poolId, [{ investor: Keypair.random().publicKey(), action: "claim_return" as const }]],
    ]);

    const firstRunPromise = daemon.runSweepCycle(targets);

    // Second concurrent run MUST immediately reject with mutual exclusion error
    expect(daemon.runSweepCycle(targets)).rejects.toThrow("Concurrent sweep cycle rejected");

    resolveFirstCycle();
    await firstRunPromise;
  });

  it("strictly attributes tranchesAdvanced from transaction event metadata disproving concurrent overcounting", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    const investor = Keypair.random().publicKey();

    // Construct confirmed Soroban TransactionMeta with claim_sec event indicating start=5, end=9 (5 tranches)
    const topic0 = xdr.ScVal.scvSymbol("claim_sec");
    const investorScVal = new Address(investor).toScVal();
    const eventData = xdr.ScVal.scvVec([xdr.ScVal.scvU32(5), xdr.ScVal.scvU32(9)]);

    const eventV0 = new xdr.ContractEventV0({
      topics: [topic0, investorScVal],
      data: eventData,
    });
    const body = new xdr.ContractEventBody(0, eventV0);
    const event = new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: null,
      type: xdr.ContractEventType.contract(),
      body: body,
    });

    const meta = new xdr.TransactionMeta(3, new xdr.TransactionMetaV3({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: new xdr.SorobanTransactionMeta({
        ext: new xdr.SorobanTransactionMetaExt(0),
        events: [event],
        returnValue: xdr.ScVal.scvU32(500),
        diagnosticEvents: [],
      }),
    }));

    // Mock executePermissionlessCall to return receipt with this resultMetaXdr
    (daemon as any).executePermissionlessCall = async () => ({
      txHash: "eventTxHash",
      committedFeeStroops: 100000n,
      effectiveFeeStroops: 100000n,
      feeSpentStroops: 100000n,
      payoutStroops: 500n,
      resultMetaXdr: meta,
    });

    // Mock getSecondaryClaimStatus to simulate Codex counterexample:
    // Suppose a third party concurrently advanced state such that totalDelta is 10,
    // but the transaction itself only advanced 5 tranches (start=5, end=9).
    let statusCallCount = 0;
    (daemon as any).getSecondaryClaimStatus = async () => {
      statusCallCount++;
      if (statusCallCount === 1) {
        return { total: 20, claimed: 0, remaining: 20 };
      }
      return { total: 20, claimed: 10, remaining: 10 }; // delta is 10!
    };

    const mockContract = {} as any;
    const receipt = await daemon.disburseSecondaryRecoveryWithReceipt(mockContract, investor, 10);

    // Assert that tranchesAdvanced is derived from the transaction event metadata (5),
    // NOT the overcounted external delta (10)!
    expect(receipt.tranchesAdvanced).toBe(5);
  });
});
