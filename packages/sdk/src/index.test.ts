import { describe, expect, it } from "bun:test";
import {
  calculateTelescopingPayout,
  calculateRemainingCapacity,
  formatUnits,
  parseUnits,
  validateContribution,
} from "./index";

describe("@kallpa/sdk", () => {
  it("calculates exact telescoping pro-rata payout with zero residuals (2-party split)", () => {
    const totalCollected = 10_000_0000000n; // 10,000 USDC
    const totalRepaid = 11_000_0000000n;   // 11,000 USDC (10% profit)

    // Contributor 1: [0, 6,000 USDC] (60%)
    const payout1 = calculateTelescopingPayout(0n, 6_000_0000000n, totalRepaid, totalCollected);
    // Contributor 2: [6,000 USDC, 10,000 USDC] (40%)
    const payout2 = calculateTelescopingPayout(6_000_0000000n, 10_000_0000000n, totalRepaid, totalCollected);

    expect(payout1).toBe(6_600_0000000n);
    expect(payout2).toBe(4_400_0000000n);
    expect(payout1 + payout2).toBe(totalRepaid);
  });

  it("calculates exact telescoping pro-rata payout with zero residuals on asymmetric 3-way split with fractional repayment", () => {
    // 3 unequal contributors dividing by 3:
    // C1: 3,333.3333333 USDC ([0, 33333333333])
    // C2: 3,333.3333333 USDC ([33333333333, 66666666666])
    // C3: 3,333.3333334 USDC ([66666666666, 100000000000])
    // Total = 10,000.0000000 USDC
    const totalCollected = 10_000_0000000n;
    const c1After = 3_333_3333333n;
    const c2After = 6_666_6666666n;
    const c3After = 10_000_0000000n;

    // Fractional repayment: 11,337.7777777 USDC
    const totalRepaid = 11_337_7777777n;

    const p1 = calculateTelescopingPayout(0n, c1After, totalRepaid, totalCollected);
    const p2 = calculateTelescopingPayout(c1After, c2After, totalRepaid, totalCollected);
    const p3 = calculateTelescopingPayout(c2After, c3After, totalRepaid, totalCollected);

    // Sum of individual telescoping payouts MUST EXACTLY equal totalRepaid
    expect(p1 + p2 + p3).toBe(totalRepaid);
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

  it("formats and parses units correctly including negative values", () => {
    const raw = 125_5000000n;
    expect(formatUnits(raw)).toBe("125.5000000");
    expect(parseUnits("125.5")).toBe(125_5000000n);
    expect(parseUnits("1000")).toBe(1000_0000000n);
    expect(parseUnits("-1.5")).toBe(-1_5000000n);
    expect(formatUnits(-1_5000000n)).toBe("-1.5000000");
  });
});
