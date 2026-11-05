import { describe, it, expect } from "bun:test";
import { KallpaKeeperDaemon, type KeeperConfig } from "./index";
import { Keypair, xdr } from "@stellar/stellar-sdk";

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

  it("short-circuits simulation when return value is i128 zero without submitting transaction", async () => {
    const daemon = new KallpaKeeperDaemon(dummyConfig);

    const { Account, Contract } = await import("@stellar/stellar-sdk");
    const mockAccount = new Account(dummyKey.publicKey(), "100");

    // Return i128 zero
    const zeroI128Val = xdr.ScVal.scvI128(
      new xdr.Int128Parts({
        hi: new xdr.Int64(0n),
        lo: new xdr.Uint64(0n),
      })
    );

    (daemon as any).server = {
      getAccount: async () => mockAccount,
      simulateTransaction: async () => ({
        result: {
          retval: zeroI128Val,
        },
      }),
      sendTransaction: async () => {
        throw new Error("sendTransaction must NOT be called on zero payout simulation!");
      },
    };

    const realContract = new Contract(dummyConfig.poolContractIds[0]);

    const result = await (daemon as any).executePermissionlessCall(
      realContract,
      "claim_secondary_recovery",
      []
    );

    expect(result).toBeNull();
  });
});
