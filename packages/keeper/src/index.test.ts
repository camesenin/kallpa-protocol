import { describe, it, expect } from "bun:test";
import { KallpaKeeperDaemon, type KeeperConfig } from "./index";
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
        result: {
          retval: exhaustedStatusVal,
          auth: [],
        },
      }),
      sendTransaction: async () => {
        throw new Error("sendTransaction must NOT be called on exhausted claim!");
      },
    };

    const realContract = new Contract(dummyConfig.poolContractIds[0]);
    const investor = Keypair.random().publicKey();

    const isExhausted = await daemon.isSecondaryClaimExhausted(
      realContract,
      new Address(investor).toScVal()
    );
    expect(isExhausted).toBe(true);

    const result = await daemon.disburseSecondaryRecovery(
      realContract,
      investor,
      25
    );
    expect(result).toBeNull();
  });

  it("does NOT short-circuit when secondary recovery has unvisited tranches (total > claimed) even if payout is zero", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);

    const { Contract } = await import("@stellar/stellar-sdk");

    // Mock get_secondary_claim_status returning tuple (26, 25) -> 1 tranche pending!
    const pendingStatusVal = xdr.ScVal.scvVec([
      xdr.ScVal.scvU32(26),
      xdr.ScVal.scvU32(25),
    ]);

    (daemon as any).server = {
      getAccount: async () => ({
        sequenceNumber: () => "100",
        incrementSequenceNumber: () => {},
      }),
      simulateTransaction: async () => ({
        result: {
          retval: pendingStatusVal,
          auth: [],
        },
      }),
    };

    const realContract = new Contract(dummyConfig.poolContractIds[0]);
    const investor = Keypair.random().publicKey();

    const isExhausted = await daemon.isSecondaryClaimExhausted(
      realContract,
      new Address(investor).toScVal()
    );
    // Must NOT be exhausted: cursor must advance!
    expect(isExhausted).toBe(false);
  });

  it("enforces maxFeePerTxStroops policy: rejects envelopes exceeding per-tx budget", async () => {
    const tightConfig: KeeperConfig = {
      ...dummyConfig,
      maxFeePerTxStroops: 50_000n, // Strict 0.005 XLM limit (below base inclusion 100_000)
    };
    const daemon = new KallpaKeeperDaemon(tightConfig);
    const { Account, Contract } = await import("@stellar/stellar-sdk");
    const mockAccount = new Account(dummyKey.publicKey(), "100");

    (daemon as any).server = {
      getAccount: async () => mockAccount,
      simulateTransaction: async () => ({
        minResourceFee: "0",
        results: [
          {
            auth: [],
            xdr: null,
          },
        ],
        transactionData: new SorobanDataBuilder().build(),
      }),
    };

    const realContract = new Contract(dummyConfig.poolContractIds[0]);
    expect(
      daemon.disburseClaimReturn(realContract, Keypair.random().publicKey())
    ).rejects.toThrow("Envelope fee exceeds maximum allowable per-transaction policy");
  });

  it("strictly enforces that next transaction does not exceed remaining sweep budget (e.g. 300k budget with 200k tx stops at 1 tx)", async () => {
    const tightSweepConfig: KeeperConfig = {
      ...dummyConfig,
      maxSweepBudgetStroops: 300_000n, // Budget: 300k
    };
    const daemon = new KallpaKeeperDaemon(tightSweepConfig);
    const poolId = tightSweepConfig.poolContractIds[0];

    // Mock solvency
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
      return { txHash: "mockHash" + callCount, feeSpentStroops: fee, payoutStroops: 1000n };
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
          { investor: Keypair.random().publicKey(), action: "claim_secondary" as const },
          { investor: Keypair.random().publicKey(), action: "claim_secondary" as const },
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
    (daemon as any).waitForConfirmation = async (hash: string) => {
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
      maxZeroPayoutTranchesPerCycle: 1, // Only 1 zero payout allowed
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
      // If investor is investor1, returns true (zero payout). If investor2, returns false (positive payout!)
      const invAddr = Address.fromScVal(args[0]).toString();
      return invAddr === investor1;
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
          { investor: investor1, action: "claim_secondary" as const }, // zero payout -> reaches maxZeroPayouts limit of 1
          { investor: investor1, action: "claim_secondary" as const }, // zero payout -> MUST be skipped
          { investor: investor2, action: "claim_secondary" as const }, // positive payout -> MUST NOT be blocked!
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
});
