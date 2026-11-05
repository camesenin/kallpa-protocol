import { describe, it, expect } from "bun:test";
import { KallpaKeeperDaemon, type KeeperConfig } from "./index";
import { Keypair } from "@stellar/stellar-sdk";

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
});
