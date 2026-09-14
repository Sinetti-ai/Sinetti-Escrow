import { ethers, networkName } from "./_hardhat";
import type { Signer } from "ethers";

/**
 * Attached-mode support: run the synthetic lifecycles against an already
 * deployed SinettiEscrowV04 instead of always deploying throwaway contracts.
 * See docs/deploy.md, "Running the synthetic lifecycles against a deployed
 * contract". Unset SINETTI_ESCROW_ADDRESS and every example behaves exactly
 * as it did before this module existed.
 */

export function isAttached(): boolean {
  return !!process.env.SINETTI_ESCROW_ADDRESS?.trim();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required when SINETTI_ESCROW_ADDRESS is set. See docs/deploy.md, ` +
        `"Running the synthetic lifecycles against a deployed contract".`
    );
  }
  return value;
}

export function envAddress(name: string): string {
  const value = requiredEnv(name);
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} (${value}) is not a valid EVM address.`);
  }
  return ethers.getAddress(value);
}

/**
 * A Wallet connected to Hardhat's configured network provider, never printed.
 * Never logs the raw key; callers must not either.
 */
export function walletFromEnv(name: string): Signer {
  const key = requiredEnv(name);
  // Validate the shape before ethers sees it: a malformed value would otherwise be
  // echoed back inside the library's error message.
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${name} is not a 32-byte hex private key. The value is not shown.`);
  }
  return new ethers.Wallet(key, ethers.provider);
}

const POLL_INTERVAL_MS = 5_000;
const PROGRESS_INTERVAL_S = 30;
// ponytail: a flat gas floor, not a real estimate. Bump if a network's gas
// price makes 0.01 native currency too tight for the transactions below.
const MIN_NATIVE_FOR_GAS = ethers.parseEther(process.env.SINETTI_MIN_NATIVE ?? "0.002");

export { MIN_NATIVE_FOR_GAS };

/**
 * Polls the chain head until its timestamp reaches `target`, printing the
 * remaining wait every ~30s. There is no local clock to fast-forward on a
 * public network, so this is a real wait. SINETTI_MAX_WAIT_SECONDS aborts it
 * with a clear error instead of hanging forever.
 */
export async function waitUntilTimestamp(target: bigint, label: string): Promise<void> {
  const maxWaitRaw = process.env.SINETTI_MAX_WAIT_SECONDS?.trim();
  const maxWaitSeconds = maxWaitRaw ? Number(maxWaitRaw) : undefined;
  if (maxWaitRaw && (!Number.isFinite(maxWaitSeconds) || maxWaitSeconds! < 0)) {
    throw new Error(`SINETTI_MAX_WAIT_SECONDS (${maxWaitRaw}) must be a non-negative integer.`);
  }

  const startedAt = Date.now();
  let lastPrintedAt = -Infinity;
  for (;;) {
    const block = await ethers.provider.getBlock("latest");
    if (!block) throw new Error("cannot read the chain head while waiting");
    const now = BigInt(block.timestamp);
    if (now >= target) return;

    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    if (elapsedSeconds - lastPrintedAt >= PROGRESS_INTERVAL_S) {
      console.log(`  waiting for ${label}: ${target - now}s of chain time remaining`);
      lastPrintedAt = elapsedSeconds;
    }
    if (maxWaitSeconds !== undefined && elapsedSeconds >= maxWaitSeconds) {
      throw new Error(
        `gave up waiting for ${label} after SINETTI_MAX_WAIT_SECONDS=${maxWaitSeconds}s; ` +
          `${target - now}s of chain time still remained`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

export type BalanceCheck = {
  label: string;
  address: string;
  token: { balanceOf(address: string): Promise<bigint> };
  minToken: bigint;
};

/**
 * Attached mode never mints or funds accounts: it checks native gas and
 * token balances up front and fails with a clear, named shortfall instead of
 * an opaque revert three transactions in.
 */
export async function requireFunded(checks: BalanceCheck[]): Promise<void> {
  const shortfalls: string[] = [];
  for (const check of checks) {
    const native = await ethers.provider.getBalance(check.address);
    if (native < MIN_NATIVE_FOR_GAS) {
      shortfalls.push(
        `${check.label} (${check.address}) has ${ethers.formatEther(native)} native currency, ` +
          `needs at least ${ethers.formatEther(MIN_NATIVE_FOR_GAS)} for gas`
      );
    }
    const tokenBalance = await check.token.balanceOf(check.address);
    if (tokenBalance < check.minToken) {
      shortfalls.push(
        `${check.label} (${check.address}) holds ${tokenBalance} token base units, ` +
          `needs at least ${check.minToken}`
      );
    }
  }
  if (shortfalls.length > 0) {
    throw new Error(`Attached-mode balance check failed:\n  ${shortfalls.join("\n  ")}`);
  }
}

/**
 * Attached-mode challenge/ruling windows: at least the deployed escrow's
 * floors, and at least `extraRulingFloor` for the ruling window (the dispute
 * example needs it to clear ConsoleArbitrator's overrideWindow + push buffer).
 */
export async function attachedWindows(
  escrow: { minChallengeWindow(): Promise<bigint>; minRulingWindow(): Promise<bigint> },
  defaults: { challengeWindow: bigint; rulingWindow: bigint },
  extraRulingFloor = 0n
): Promise<{ challengeWindow: bigint; rulingWindow: bigint }> {
  const [minChallengeWindow, minRulingWindow] = await Promise.all([
    escrow.minChallengeWindow(),
    escrow.minRulingWindow()
  ]);
  const challengeWindow =
    defaults.challengeWindow > minChallengeWindow ? defaults.challengeWindow : minChallengeWindow;
  const rulingFloor = minRulingWindow > extraRulingFloor ? minRulingWindow : extraRulingFloor;
  const rulingWindow = defaults.rulingWindow > rulingFloor ? defaults.rulingWindow : rulingFloor;
  return { challengeWindow, rulingWindow };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

const BPS_DENOMINATOR = 10_000n;

/**
 * Picks deal amounts that respect the deployed escrow's per-token caps and
 * bond floors, preferring the local examples' usual figures when they fit
 * under the caps.
 */
export async function attachedDealAmounts(
  escrow: {
    maxAmountOf(token: string): Promise<bigint>;
    maxBondOf(token: string): Promise<bigint>;
    minBondBpsOf(token: string): Promise<bigint>;
    minChallengerBondBpsOf(token: string): Promise<bigint>;
  },
  tokenAddress: string,
  requested: { amount: bigint; bond: bigint; challengerBond: bigint }
): Promise<{ amount: bigint; bond: bigint; challengerBond: bigint }> {
  const [maxAmount, maxBond, minBondBps, minChallengerBondBps] = await Promise.all([
    escrow.maxAmountOf(tokenAddress),
    escrow.maxBondOf(tokenAddress),
    escrow.minBondBpsOf(tokenAddress),
    escrow.minChallengerBondBpsOf(tokenAddress)
  ]);

  const amount = requested.amount < maxAmount ? requested.amount : maxAmount;
  if (amount === 0n) {
    throw new Error(`SINETTI_TOKEN_ADDRESS's deployed maxAmount cap is 0; no deal can be opened.`);
  }

  const minBond = ceilDiv(amount * minBondBps, BPS_DENOMINATOR);
  let bond = requested.bond < maxBond ? requested.bond : maxBond;
  if (bond < minBond) bond = minBond;
  if (bond > maxBond) {
    throw new Error(
      `the deployed bond floor (${minBond} base units at ${minBondBps}bps of amount ${amount}) ` +
        `exceeds the deployed maxBond cap (${maxBond}); lower the deal amount or raise the cap.`
    );
  }

  const minChallengerBond = ceilDiv(amount * minChallengerBondBps, BPS_DENOMINATOR);
  let challengerBond = requested.challengerBond < amount ? requested.challengerBond : amount;
  if (challengerBond < minChallengerBond) challengerBond = minChallengerBond;
  if (challengerBond === 0n) challengerBond = 1n;
  if (challengerBond > amount) {
    throw new Error(
      `the deployed challenger-bond floor (${minChallengerBond} base units) exceeds the deal amount (${amount}).`
    );
  }

  return { amount, bond, challengerBond };
}
