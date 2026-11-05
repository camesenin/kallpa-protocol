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
          minResourceFee: "100000", // 100k restoration fee
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
});
