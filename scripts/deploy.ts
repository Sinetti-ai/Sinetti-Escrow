import { execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { network } from "hardhat";
import type { HardhatEthersHelpers } from "@nomicfoundation/hardhat-ethers/types";

const connection = await network.create();
const { ethers } = connection;

/**
 * Deploys SinettiEscrowV04 and, pointed at it, ConsoleArbitrator.
 *
 * Every policy input is explicit via environment variables; see .env.example.
 * The one default is TOKEN_MAX_AMOUNT / TOKEN_MAX_BOND falling back to
 * uint256 max when unset, matching an "uncapped" deployment rather than a
 * silent zero.
 */

const BPS_DENOMINATOR = 10_000n;

/// Mirrors SinettiEscrowV04's ABSOLUTE_MIN_CHALLENGE_WINDOW / MAX_CHALLENGE_WINDOW.
const ABSOLUTE_MIN_CHALLENGE_WINDOW = 60n;
const MAX_CHALLENGE_WINDOW = 30n * 86_400n;
/// Mirrors ABSOLUTE_MIN_RULING_WINDOW / MAX_RULING_WINDOW.
const ABSOLUTE_MIN_RULING_WINDOW = 60n;
const MAX_RULING_WINDOW = 90n * 86_400n;
/// Mirrors ConsoleArbitrator's MIN_OVERRIDE_WINDOW / MAX_OVERRIDE_WINDOW.
const MIN_OVERRIDE_WINDOW = 1n * 86_400n;
const MAX_OVERRIDE_WINDOW = 30n * 86_400n;

const LOCAL_NETWORKS = new Set(["default", "localhost"]);

type DeployRuntime = {
  networkName: string;
  ethers: Pick<HardhatEthersHelpers, "getContractFactory" | "getSigners" | "provider">;
};

function requiredAddress(env: NodeJS.ProcessEnv, name: string): string {
  const configured = env[name]?.trim();
  if (!configured) {
    throw new Error(`${name} is required. Set it to a valid non-zero EVM address.`);
  }
  if (!ethers.isAddress(configured) || configured === ethers.ZeroAddress) {
    throw new Error(`${name} must be a valid non-zero EVM address.`);
  }
  return ethers.getAddress(configured);
}

function addressAllowlist(env: NodeJS.ProcessEnv, name: string): string[] {
  const configured = env[name]?.trim();
  if (!configured) return [];
  const addresses = configured.split(",").map((value, index) => {
    const candidate = value.trim();
    if (!candidate || !ethers.isAddress(candidate) || candidate === ethers.ZeroAddress) {
      throw new Error(`${name} entry ${index + 1} must be a valid non-zero EVM address.`);
    }
    return ethers.getAddress(candidate);
  });
  const duplicate = addresses.find(
    (address, index) => addresses.indexOf(address) !== index
  );
  if (duplicate) {
    throw new Error(`${name} must not contain duplicate addresses.`);
  }
  return addresses;
}

function requiredUint(env: NodeJS.ProcessEnv, name: string): bigint {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") {
    throw new Error(`${name} is required. Set it deliberately, including 0 where 0 is legal.`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return BigInt(raw);
}

function optionalUint(env: NodeJS.ProcessEnv, name: string, fallback: bigint): bigint {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return BigInt(raw);
}

function requiredBps(env: NodeJS.ProcessEnv, name: string): bigint {
  const value = requiredUint(env, name);
  if (value > 65_535n) {
    throw new Error(`${name} must fit in an unsigned 16-bit integer.`);
  }
  return value;
}

/// Mirrors the constructor's UnsatisfiableChallengerBondPolicy / UnsatisfiableBondPolicy checks.
export function validateTokenPolicy(
  maxAmount: bigint,
  maxBond: bigint,
  minBondBps: bigint,
  minChallengerBondBps: bigint
): void {
  if (minChallengerBondBps > BPS_DENOMINATOR) {
    throw new Error(
      "TOKEN_MIN_CHALLENGER_BOND_BPS must not exceed 10000; SinettiEscrowV04 reverts UnsatisfiableChallengerBondPolicy otherwise."
    );
  }
  const worstCaseBond = (maxAmount * minBondBps + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  if (minBondBps > 0n && worstCaseBond > maxBond) {
    throw new Error(
      "TOKEN_MAX_AMOUNT, TOKEN_MAX_BOND, and TOKEN_MIN_BOND_BPS must permit the worst-case bond; SinettiEscrowV04 reverts UnsatisfiableBondPolicy otherwise."
    );
  }
}

/// Mirrors ChallengeWindowFloorOutOfBounds / RulingWindowFloorOutOfBounds.
export function validateWindowFloors(minChallengeWindow: bigint, minRulingWindow: bigint): void {
  if (minChallengeWindow < ABSOLUTE_MIN_CHALLENGE_WINDOW || minChallengeWindow > MAX_CHALLENGE_WINDOW) {
    throw new Error(
      `MIN_CHALLENGE_WINDOW_SECONDS must be between ${ABSOLUTE_MIN_CHALLENGE_WINDOW} and ${MAX_CHALLENGE_WINDOW}; SinettiEscrowV04 reverts ChallengeWindowFloorOutOfBounds otherwise.`
    );
  }
  if (minRulingWindow < ABSOLUTE_MIN_RULING_WINDOW || minRulingWindow > MAX_RULING_WINDOW) {
    throw new Error(
      `MIN_RULING_WINDOW_SECONDS must be between ${ABSOLUTE_MIN_RULING_WINDOW} and ${MAX_RULING_WINDOW}; SinettiEscrowV04 reverts RulingWindowFloorOutOfBounds otherwise.`
    );
  }
}

/// Mirrors OverrideWindowTooShort / OverrideWindowTooLong.
export function validateOverrideWindow(overrideWindow: bigint): void {
  if (overrideWindow < MIN_OVERRIDE_WINDOW || overrideWindow > MAX_OVERRIDE_WINDOW) {
    throw new Error(
      `ARBITRATOR_OVERRIDE_WINDOW_SECONDS must be between ${MIN_OVERRIDE_WINDOW} and ${MAX_OVERRIDE_WINDOW}; ConsoleArbitrator reverts OverrideWindowTooShort/OverrideWindowTooLong otherwise.`
    );
  }
}

/// Mirrors InsufficientParticipants / NoArbitrators: a restricted participant
/// allowlist needs at least three participants and at least one arbitrator.
export function validateAdmissionCardinality(participants: string[], arbitrators: string[]): void {
  if (participants.length === 0) return;
  if (participants.length < 3) {
    throw new Error(
      "A restricted deployment needs at least 3 allowlisted participants (buyer, seller, verifier); SinettiEscrowV04 reverts InsufficientParticipants otherwise."
    );
  }
  if (arbitrators.length === 0) {
    throw new Error(
      "ARBITRATOR_ALLOWLIST must name at least one arbitrator when the participant allowlist is enabled; SinettiEscrowV04 reverts NoArbitrators otherwise."
    );
  }
}

type CodeProvider = { getCode(address: string): Promise<string> };

/// Mirrors TokenHasNoCode: catch it before spending gas.
export async function validateTokenCode(provider: CodeProvider, tokenAddress: string): Promise<void> {
  if ((await provider.getCode(tokenAddress)) === "0x") {
    throw new Error("TOKEN_ADDRESS has no bytecode. This check does not prove ERC-20 compatibility.");
  }
}

/// Mirrors ArbitratorHasNoCode: every allowlisted arbitrator must be a contract.
export async function validateArbitratorCode(provider: CodeProvider, arbitrators: string[]): Promise<void> {
  for (const address of arbitrators) {
    if ((await provider.getCode(address)) === "0x") {
      throw new Error(
        `ARBITRATOR_ALLOWLIST entry ${address} has no bytecode. openDeal reverts ArbitratorHasNoCode for an arbitrator address without code.`
      );
    }
  }
}

export type RoleSeparationInput = {
  deployer: string;
  pauser: string;
  agentKey: string;
  officer: string;
  networkName: string;
};

/// Refuses role concentration outright on a public network; no acknowledgement
/// override. A local network (hardhat/localhost) is exempt because there is
/// only ever one funded signer.
export function validateRoleSeparation({ deployer, pauser, agentKey, officer, networkName }: RoleSeparationInput): void {
  if (LOCAL_NETWORKS.has(networkName)) return;

  const violations: string[] = [];
  if (deployer === pauser) violations.push("deployer equals pauser");
  if (agentKey === officer) violations.push("arbitrator agentKey equals officer");
  if (officer === pauser) violations.push("arbitrator officer equals pauser");

  if (violations.length > 0) {
    throw new Error(
      `Role separation policy violated on ${networkName}: ${violations.join("; ")}. ` +
      "A single key controlling pause, the agent proposal path, and the officer override defeats the point of separating them. Use distinct addresses."
    );
  }
}

function pauserAddress(env: NodeJS.ProcessEnv, networkName: string, deployerAddress: string): string {
  const configured = env.PAUSER_ADDRESS?.trim();
  if (!configured) {
    if (LOCAL_NETWORKS.has(networkName)) return deployerAddress;
    throw new Error("PAUSER_ADDRESS is required on non-local networks. Set it explicitly to a valid non-zero EVM address.");
  }
  if (!ethers.isAddress(configured) || configured === ethers.ZeroAddress) {
    throw new Error("PAUSER_ADDRESS must be a valid non-zero EVM address.");
  }
  return ethers.getAddress(configured);
}

function commitHash(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: import.meta.dirname, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function deployContract(
  runtime: DeployRuntime,
  name: string,
  args: unknown[]
): Promise<{ address: string; txHash: string; blockNumber: number | null }> {
  const factory = await runtime.ethers.getContractFactory(name);
  const contract = await (factory as any).deploy(...args);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const transaction = contract.deploymentTransaction();
  if (!transaction) {
    throw new Error(`Deployment transaction missing for ${name}`);
  }
  const receipt = await transaction.wait();

  return { address, txHash: transaction.hash, blockNumber: receipt?.blockNumber ?? null };
}

export async function main(
  runtime: DeployRuntime = connection,
  deploymentsDir = path.join(process.cwd(), "deployments")
): Promise<void> {
  const networkName = runtime.networkName;
  const env = process.env;

  if (!LOCAL_NETWORKS.has(networkName) && !env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("DEPLOYER_PRIVATE_KEY is required off the local networks (default, localhost). Set it in .env before running this deploy.");
  }

  const tokenAddress = requiredAddress(env, "TOKEN_ADDRESS");
  const maxAmount = optionalUint(env, "TOKEN_MAX_AMOUNT", ethers.MaxUint256);
  const maxBond = optionalUint(env, "TOKEN_MAX_BOND", ethers.MaxUint256);
  const minBondBps = requiredBps(env, "TOKEN_MIN_BOND_BPS");
  const minChallengerBondBps = requiredBps(env, "TOKEN_MIN_CHALLENGER_BOND_BPS");
  const minChallengeWindow = requiredUint(env, "MIN_CHALLENGE_WINDOW_SECONDS");
  const minRulingWindow = requiredUint(env, "MIN_RULING_WINDOW_SECONDS");
  const participants = addressAllowlist(env, "PARTICIPANT_ALLOWLIST");
  const arbitrators = addressAllowlist(env, "ARBITRATOR_ALLOWLIST");
  const agentKey = requiredAddress(env, "ARBITRATOR_AGENT_ADDRESS");
  const officer = requiredAddress(env, "ARBITRATOR_OFFICER");
  const overrideWindow = requiredUint(env, "ARBITRATOR_OVERRIDE_WINDOW_SECONDS");

  validateTokenPolicy(maxAmount, maxBond, minBondBps, minChallengerBondBps);
  validateWindowFloors(minChallengeWindow, minRulingWindow);
  validateOverrideWindow(overrideWindow);
  validateAdmissionCardinality(participants, arbitrators);

  await validateTokenCode(runtime.ethers.provider, tokenAddress);
  await validateArbitratorCode(runtime.ethers.provider, arbitrators);

  const signers = await runtime.ethers.getSigners();
  if (signers.length === 0) {
    throw new Error("No deployer signer configured. Set DEPLOYER_PRIVATE_KEY in .env before running this deploy.");
  }
  const [deployer] = signers;
  const deployerAddress = await deployer.getAddress();
  const pauser = pauserAddress(env, networkName, deployerAddress);

  validateRoleSeparation({ deployer: deployerAddress, pauser, agentKey, officer, networkName });

  const network = await runtime.ethers.provider.getNetwork();

  const escrowArgs = [
    pauser,
    [{ token: tokenAddress, maxAmount, maxBond, minBondBps, minChallengerBondBps }],
    participants,
    arbitrators,
    minChallengeWindow,
    minRulingWindow
  ];

  console.log(`Deploying to ${networkName} (chainId ${network.chainId}) from ${deployerAddress}`);

  // ESCROW_ADDRESS reuses a live escrow and deploys only a new ConsoleArbitrator
  // against it. Existing deals stay bound to whatever arbitrator they named.
  const reuseEscrow = env.ESCROW_ADDRESS?.trim();
  const deploymentPath = path.join(deploymentsDir, `${networkName}.json`);
  let escrow: { address: string; txHash?: string; blockNumber?: number | null };
  let escrowRecord: unknown;
  if (reuseEscrow) {
    escrow = { address: requiredAddress(env, "ESCROW_ADDRESS") };
    const code = await runtime.ethers.provider.getCode(escrow.address);
    if (code === "0x") throw new Error(`ESCROW_ADDRESS ${escrow.address} has no bytecode.`);
    const previous = JSON.parse(await readFile(deploymentPath, "utf8")) as { escrow: { address: string } };
    if (previous.escrow.address.toLowerCase() !== escrow.address.toLowerCase()) {
      throw new Error(`ESCROW_ADDRESS ${escrow.address} does not match ${deploymentPath} (${previous.escrow.address}).`);
    }
    escrowRecord = previous.escrow;
    console.log(`Reusing SinettiEscrowV04: ${escrow.address}`);
  } else {
    escrow = await deployContract(runtime, "SinettiEscrowV04", escrowArgs);
    console.log(`SinettiEscrowV04: ${escrow.address}`);
  }

  const arbitratorArgs = [escrow.address, agentKey, officer, overrideWindow];
  const arbitrator = await deployContract(runtime, "ConsoleArbitrator", arbitratorArgs);
  console.log(`ConsoleArbitrator: ${arbitrator.address}`);

  const stringify = (value: unknown): unknown =>
    typeof value === "bigint" ? value.toString() : value;

  const rpcUrl = env.SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com";

  const deployment = {
    network: networkName,
    chainId: Number(network.chainId),
    commit: commitHash(),
    timestamp: new Date().toISOString(),
    escrow: escrowRecord ?? {
      contract: "SinettiEscrowV04",
      address: escrow.address,
      txHash: escrow.txHash,
      block: escrow.blockNumber,
      constructorArgs: JSON.parse(JSON.stringify(escrowArgs, (_, v) => stringify(v)))
    },
    arbitrator: {
      contract: "ConsoleArbitrator",
      address: arbitrator.address,
      txHash: arbitrator.txHash,
      block: arbitrator.blockNumber,
      constructorArgs: JSON.parse(JSON.stringify(arbitratorArgs, (_, v) => stringify(v)))
    },
    verification: {
      kind: "reproducible from chain; the tooling that ran these checks is not attested",
      method: `cast against ${rpcUrl}`,
      reproduce: `cast code ${escrow.address} --rpc-url ${rpcUrl}; cast call ${arbitrator.address} "escrow()(address)" --rpc-url ${rpcUrl}; cast call ${arbitrator.address} "overrideWindow()(uint64)" --rpc-url ${rpcUrl}`,
      checks: [
        `code present at escrow (${escrow.address}) and arbitrator (${arbitrator.address})`,
        `arbitrator.escrow() == ${escrow.address}`,
        `arbitrator.overrideWindow() == ${overrideWindow}, agentKey == ${agentKey}, officer == ${officer}`
      ]
    }
  };

  await mkdir(deploymentsDir, { recursive: true });
  await writeFile(deploymentPath, `${JSON.stringify(deployment, null, 2)}\n`);

  console.log("\nDeployment summary");
  console.log(`Network: ${networkName}`);
  console.log(`Escrow: ${escrow.address}`);
  console.log(`Arbitrator: ${arbitrator.address}`);
  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Pauser: ${pauser}`);
  console.log(`Deployment file: ${deploymentPath}`);

  console.log("\nVerify with forge (see docs/deploy.md):");
  console.log(
    `forge verify-contract ${escrow.address} contracts/SinettiEscrowV04.sol:SinettiEscrowV04 --chain sepolia --etherscan-api-key $ETHERSCAN_API_KEY`
  );
  console.log(
    `forge verify-contract ${arbitrator.address} contracts/ConsoleArbitrator.sol:ConsoleArbitrator --chain sepolia --etherscan-api-key $ETHERSCAN_API_KEY`
  );
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
