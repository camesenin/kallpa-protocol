import { describe, expect, it } from "bun:test";
import {
  calculateRemainingCapacity,
  calculateTelescopingPayout,
  formatUnits,
  parseUnits,
  validateContribution,
} from "./index";

describe("@kallpa/sdk", () => {
  it("calculates exact telescoping pro-rata payout with zero residuals (2-party split)", () => {
    const totalCollected = 10000000000n; // 1,000 USDC
    const totalRepaid = 11000000000n; // 1,100 USDC (with 10% premium)

    const c1Prior = 0n;
    const c1After = 6000000000n; // 60%
    const payout1 = calculateTelescopingPayout(c1Prior, c1After, totalRepaid, totalCollected);

    const c2Prior = 6000000000n;
    const c2After = 10000000000n; // 40%
    const payout2 = calculateTelescopingPayout(c2Prior, c2After, totalRepaid, totalCollected);

    expect(payout1).toBe(6600000000n);
    expect(payout2).toBe(4400000000n);
    expect(payout1 + payout2).toBe(totalRepaid);
  });

  it("calculates exact telescoping pro-rata payout with zero residuals on asymmetric 3-way split with fractional repayment", () => {
    const totalCollected = 33333333n;
    const totalRepaid = 10000000n;

    const p1 = calculateTelescopingPayout(0n, 11111111n, totalRepaid, totalCollected);
    const p2 = calculateTelescopingPayout(11111111n, 22222222n, totalRepaid, totalCollected);
    const p3 = calculateTelescopingPayout(22222222n, 33333333n, totalRepaid, totalCollected);

    expect(p1 + p2 + p3).toBe(totalRepaid);
  });

  it("enforces boundary checks on calculateTelescopingPayout", () => {
    expect(() => calculateTelescopingPayout(10n, 5n, 100n, 100n)).toThrow("cumAfter must be greater");
    expect(() => calculateTelescopingPayout(0n, 150n, 100n, 100n)).toThrow("cumAfter cannot exceed");
    expect(() => calculateTelescopingPayout(0n, 50n, -10n, 100n)).toThrow("Total repaid cannot be negative");
  });

  it("calculates remaining capacity accurately", () => {
    expect(calculateRemainingCapacity(1000n, 400n)).toBe(600n);
    expect(calculateRemainingCapacity(1000n, 1000n)).toBe(0n);
    expect(calculateRemainingCapacity(1000n, 1200n)).toBe(0n);
  });

  it("validates contribution clamping to remaining capacity", () => {
    const res = validateContribution(500n, 100n, 300n);
    expect(res.valid).toBe(true);
    expect(res.actualAmount).toBe(300n);

    const invalidMin = validateContribution(50n, 100n, 300n);
    expect(invalidMin.valid).toBe(false);
    expect(invalidMin.error).toContain("below minimum ticket");
  });

  it("formats and parses units strictly", () => {
    expect(formatUnits(10500000n, 7)).toBe("1.05");
    expect(formatUnits(10000000n, 7)).toBe("1");
    expect(formatUnits(-5000000n, 7)).toBe("-0.5");

    expect(parseUnits("1.05", 7)).toBe(10500000n);
    expect(parseUnits("1", 7)).toBe(10000000n);
    expect(parseUnits("-0.5", 7)).toBe(-5000000n);

    expect(() => parseUnits("1.2.3", 7)).toThrow("Invalid decimal format");
    expect(() => parseUnits("1.12345678", 7)).toThrow("exceed precision limit");
  });
});
