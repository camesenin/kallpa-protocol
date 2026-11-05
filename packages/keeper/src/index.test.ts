import { describe, it, expect } from "bun:test";
import { KallpaKeeperDaemon, type KeeperConfig } from "./index";
import { Keypair, xdr, Address } from "@stellar/stellar-sdk";

describe("@kallpa/keeper", () => {
  const dummyKey = Keypair.random();
  const dummyConfig: KeeperConfig = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    sponsorSecret: dummyKey.secret(),
    poolContractIds: ["CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFCT4"],
    maxTranchesPerBatch: 25,
    minSponsorReserveStroops: 50_000_000n, // 5 XLM
  };

  it("initializes successfully with valid configuration", () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    expect(daemon).toBeDefined();
  });

  it("strictly validates maxTranches: rejects non-integers, out-of-bounds, negative or NaN", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);
    const mockContract = {} as any;

    // Test rejection of non-integers
    expect(daemon.disburseSecondaryRecovery(mockContract, "GAAA", 1.5)).rejects.toThrow(
      "Must be an integer between 1 and 50"
    );

    // Test rejection of 0
    expect(daemon.disburseSecondaryRecovery(mockContract, "GAAA", 0)).rejects.toThrow(
      "Must be an integer between 1 and 50"
    );

    // Test rejection of > 50
    expect(daemon.disburseSecondaryRecovery(mockContract, "GAAA", 51)).rejects.toThrow(
      "Must be an integer between 1 and 50"
    );

    // Test rejection of negative
    expect(daemon.disburseSecondaryRecovery(mockContract, "GAAA", -5)).rejects.toThrow(
      "Must be an integer between 1 and 50"
    );

    // Test rejection of NaN
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

    const result = await (daemon as any).executePermissionlessCall(
      realContract,
      "claim_secondary_recovery",
      [new Address(investor).toScVal()]
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
});
