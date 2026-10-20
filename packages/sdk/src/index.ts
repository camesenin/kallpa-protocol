/**
 * @kallpa/sdk - Client Domain Logic & Telescoping Math for Kallpa Protocol
 * Multi-party capital pooling and zero-dust pro-rata settlement for Trustless Work escrows on Stellar & Soroban.
 */

export interface PoolConfig {
  admin: string;
  asset: string;
  twEscrow: string;
  payer: string;
  targetAmount: bigint;
  deadline: number;
  minContribution: bigint;
}

export interface InvestorPosition {
  investor: string;
  principal: bigint;
  cumPrior: bigint;
  cumAfter: bigint;
  claimed: boolean;
}

export enum PoolState {
  Open = 0,
  Funded = 1,
  Settled = 2,
  Refundable = 3,
  Disputed = 4,
}

/**
 * Calculates exact pro-rata entitlement of a contributor upon settlement or dispute refund
 * using algebraic telescoping prefix sums:
 * Payout_i = floor(cumAfter * totalRepaid / totalCollected) - floor(cumPrior * totalRepaid / totalCollected)
 *
 * Guarantees zero residual dust and strict conservation of funds across all participants.
 */
export function calculateTelescopingPayout(
  cumPrior: bigint,
  cumAfter: bigint,
  totalRepaid: bigint,
  totalCollected: bigint
): bigint {
  if (totalCollected <= 0n) {
    throw new Error("Total collected must be greater than zero");
  }
  if (totalRepaid < 0n) {
    throw new Error("Total repaid cannot be negative");
  }
  if (cumPrior < 0n) {
    throw new Error("cumPrior cannot be negative");
  }
  if (cumAfter < cumPrior) {
    throw new Error("cumAfter must be greater than or equal to cumPrior");
  }
  if (cumAfter > totalCollected) {
    throw new Error("cumAfter cannot exceed totalCollected");
  }

  const upper = (cumAfter * totalRepaid) / totalCollected;
  const lower = (cumPrior * totalRepaid) / totalCollected;
  return upper - lower;
}

/**
 * Calculates remaining funding capacity for a pool.
 */
export function calculateRemainingCapacity(
  targetAmount: bigint,
  totalCollected: bigint
): bigint {
  if (totalCollected >= targetAmount) {
    return 0n;
  }
  return targetAmount - totalCollected;
}

/**
 * Validates a contribution amount against minimum ticket and available capacity.
 */
export function validateContribution(
  amount: bigint,
  minContribution: bigint,
  remainingCapacity: bigint
): { valid: boolean; actualAmount: bigint; error?: string } {
  if (amount <= 0n) {
    return { valid: false, actualAmount: 0n, error: "Contribution amount must be positive" };
  }
  if (remainingCapacity <= 0n) {
    return { valid: false, actualAmount: 0n, error: "Pool capacity has been fully reached" };
  }
  if (amount < minContribution) {
    return {
      valid: false,
      actualAmount: 0n,
      error: `Contribution is below minimum ticket (${minContribution.toString()})`,
    };
  }

  const actualAmount = amount > remainingCapacity ? remainingCapacity : amount;
  return { valid: true, actualAmount };
}

/**
 * Format stroops (or base units with given decimals) to human-readable decimal string.
 */
export function formatUnits(value: bigint, decimals: number = 7): string {
  const isNegative = value < 0n;
  const absValue = isNegative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const integerPart = absValue / divisor;
  const remainder = absValue % divisor;

  if (remainder === 0n) {
    return `${isNegative ? "-" : ""}${integerPart.toString()}`;
  }

  const paddedFraction = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${isNegative ? "-" : ""}${integerPart.toString()}.${paddedFraction}`;
}

/**
 * Parse a human decimal string into base units (e.g. stroops for USDC with 7 decimals).
 * Strictly validates decimal format and forbids extraneous dots or invalid characters.
 */
export function parseUnits(value: string, decimals: number = 7): bigint {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Cannot parse empty string into units");
  }

  // Strict regex: optional sign, digits, optional single dot followed by digits
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid decimal format: "${value}"`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const intPart = BigInt(match[2]);
  const fractionStr = match[3] || "";

  if (fractionStr.length > decimals) {
    throw new Error(`Fractional digits exceed precision limit (${decimals})`);
  }

  const paddedFraction = fractionStr.padEnd(decimals, "0");
  const fracPart = BigInt(paddedFraction);
  const total = intPart * (10n ** BigInt(decimals)) + fracPart;

  return total * sign;
}
