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
 * Calculates exact pro-rata entitlement of a contributor upon settlement using
 * algebraic telescoping prefix sums:
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
  if (cumAfter < cumPrior) {
    throw new Error("cumAfter must be greater than or equal to cumPrior");
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
    return { valid: false, actualAmount: 0n, error: "Pool capacity is already full" };
  }
  if (amount < minContribution) {
    return {
      valid: false,
      actualAmount: 0n,
      error: `Contribution below minimum allowed (${minContribution.toString()})`,
    };
  }

  const actualAmount = amount > remainingCapacity ? remainingCapacity : amount;
  return { valid: true, actualAmount };
}

/**
 * Formats a raw 7-decimal Soroban integer (e.g. 10_0000000) to human readable string (10.00 USDC).
 */
export function formatUnits(amount: bigint, decimals: number = 7): string {
  const isNegative = amount < 0n;
  const absAmount = isNegative ? -amount : amount;
  const divisor = 10n ** BigInt(decimals);
  const integerPart = absAmount / divisor;
  const fractionalPart = absAmount % divisor;
  const paddedFractional = fractionalPart.toString().padStart(decimals, "0");
  return `${isNegative ? "-" : ""}${integerPart.toString()}.${paddedFractional}`;
}

/**
 * Parses a decimal string (e.g. "150.50") into a raw 7-decimal BigInt.
 */
export function parseUnits(amountStr: string, decimals: number = 7): bigint {
  const cleanStr = amountStr.trim();
  const isNegative = cleanStr.startsWith("-");
  const unsignedStr = isNegative ? cleanStr.slice(1) : cleanStr;

  const parts = unsignedStr.split(".");
  const intPart = BigInt(parts[0] || "0");
  let val = intPart * (10n ** BigInt(decimals));
  if (parts.length > 1) {
    const fracPartStr = parts[1].slice(0, decimals).padEnd(decimals, "0");
    val += BigInt(fracPartStr);
  }
  return isNegative ? -val : val;
}
