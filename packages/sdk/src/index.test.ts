import { describe, expect, it } from "bun:test";
import {
  calculateProRataPayout,
  calculateRemainingCapacity,
  formatUnits,
  parseUnits,
  validateContribution,
} from "./index";

describe("@kallpa/sdk", () => {
  it("calculates exact pro-rata payout with zero residuals", () => {
    const totalCollected = 10_000_0000000n; // 10,000 USDC
    const totalRepaid = 11_000_0000000n;   // 11,000 USDC (10% profit)

    const inv1Principal = 6_000_0000000n;  // 60%
    const inv2Principal = 4_000_0000000n;  // 40%

    const payout1 = calculateProRataPayout(inv1Principal, totalRepaid, totalCollected);
    const payout2 = calculateProRataPayout(inv2Principal, totalRepaid, totalCollected);

    expect(payout1).toBe(6_600_0000000n);
    expect(payout2).toBe(4_400_0000000n);
    expect(payout1 + payout2).toBe(totalRepaid);
  });

  it("calculates remaining capacity accurately", () => {
    const target = 10_000_0000000n;
    expect(calculateRemainingCapacity(target, 4_000_0000000n)).toBe(6_000_0000000n);
    expect(calculateRemainingCapacity(target, 10_000_0000000n)).toBe(0n);
    expect(calculateRemainingCapacity(target, 12_000_0000000n)).toBe(0n);
  });

  it("validates contribution clamping to remaining capacity", () => {
    const minTicket = 100_0000000n;
    const remaining = 500_0000000n;

    // Normal contribution
    const res1 = validateContribution(300_0000000n, minTicket, remaining);
    expect(res1.valid).toBe(true);
    expect(res1.actualAmount).toBe(300_0000000n);

    // Contribution exceeding capacity should be clamped
    const res2 = validateContribution(800_0000000n, minTicket, remaining);
    expect(res2.valid).toBe(true);
    expect(res2.actualAmount).toBe(500_0000000n);

    // Contribution below minimum ticket
    const res3 = validateContribution(50_0000000n, minTicket, remaining);
    expect(res3.valid).toBe(false);
  });

  it("formats and parses units correctly", () => {
    const raw = 125_5000000n;
    expect(formatUnits(raw)).toBe("125.5000000");
    expect(parseUnits("125.5")).toBe(125_5000000n);
    expect(parseUnits("1000")).toBe(1000_0000000n);
  });
});
