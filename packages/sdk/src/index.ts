/**
 * @kallpa/sdk - Official Client & Domain Logic for Kallpa Finance
 * Multi-investor RWA invoice factoring protocol on Soroban and Trustless Work EaaS.
 */

export interface PoolConfig {
  admin: string;
  asset: string;
  twEscrow: string;
  targetAmount: bigint;
  deadline: number;
  minContribution: bigint;
}

export interface InvestorPosition {
  investor: string;
  principal: bigint;
  claimed: boolean;
}

export enum PoolState {
  Open = 0,
  Funded = 1,
  Settled = 2,
  Refundable = 3,
}

export interface InvoiceMetadata {
  invoiceId: string;
  supplierAddress: string;
  debtorAddress: string;
  faceValueUsdc: bigint;
  advanceRateBps: number; // e.g. 8000 = 80%
  discountFeeBps: number;  // e.g. 500 = 5% flat fee
  dueDateTimestamp: number;
}

/**
 * Calculates exact pro-rata entitlement of an investor upon invoice repayment.
 * Guaranteed deterministic integer math without precision loss or floating point residuals.
 */
export function calculateProRataPayout(
  principal: bigint,
  totalRepaid: bigint,
  totalCollected: bigint
): bigint {
  if (totalCollected <= 0n) {
    throw new Error("Total collected must be greater than zero");
  }
  if (principal <= 0n) {
    throw new Error("Principal must be greater than zero");
  }
  return (principal * totalRepaid) / totalCollected;
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
  if (amount < minContribution && remainingCapacity >= minContribution) {
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
  const parts = amountStr.trim().split(".");
  const intPart = BigInt(parts[0] || "0");
  if (parts.length === 1) {
    return intPart * (10n ** BigInt(decimals));
  }
  const fracPartStr = parts[1].slice(0, decimals).padEnd(decimals, "0");
  const fracPart = BigInt(fracPartStr);
  return intPart * (10n ** BigInt(decimals)) + fracPart;
}
