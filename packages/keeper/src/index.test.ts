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

    (daemon as any).disburseSecondaryRecoveryWithReceipt = async (
      _contract: any,
      _investor: any,
      _tranches: number,
      _remaining: bigint
    ) => {
      // Confirmed on-chain advancement with 0 payout
      return { txHash: "mockHashAdvancement", feeSpentStroops: 100_000n, payoutStroops: 0n };
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
});
