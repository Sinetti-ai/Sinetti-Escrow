import type {
  ContractTransactionReceipt,
  ContractTransactionResponse,
  LogDescription,
  Signer
} from "ethers";
import { ethers, networkName } from "./_hardhat";
import path from "node:path";
import { canonicalJson, hashFile } from "../src/evidenceManifest";
import { signSellerAcceptance } from "../src/sellerAcceptance";
import { VERIFIER_VERSION, type AcceptanceCriteria } from "../src/verifier";
import { repoCommitHash, runtimeHash } from "./_evidence";
import { attachedDealAmounts, envAddress, isAttached, requireFunded, walletFromEnv } from "./_network";

import type {
  ConsoleArbitrator,
  IERC20,
  MockManualArbitrator,
  SinettiEscrowV04,
  TestEUR
} from "../typechain-types";

export const AMOUNT = ethers.parseUnits("25", 6);
export const BOND = ethers.parseUnits("5", 6);
export const CHALLENGER_BOND = ethers.parseUnits("10", 6);

export function exampleCriteria(): AcceptanceCriteria {
  return {
    acceptance_criteria_id: "crit_example",
    acceptance_type: "schema_validity",
    verification_method: "deterministic",
    evidence_required: ["customer_export"],
    auto_release_threshold: "schema_valid",
    schema_or_test_ref: "schemas/customer-export.schema.json",
    artifact_path: "customer-export.json",
    schema_hash: hashFile(path.resolve(import.meta.dirname, "../schemas/customer-export.schema.json")),
    repo_commit_hash: repoCommitHash(),
    runtime_hash: runtimeHash(),
    verifier_version: VERIFIER_VERSION,
    created_at: "2026-01-01T00:00:00Z"
  };
}

export type LocalContext = {
  deployer: Signer;
  buyer: Signer;
  seller: Signer;
  verifier: Signer;
  buyerAddress: string;
  sellerAddress: string;
  verifierAddress: string;
  arbitratorAddress: string;
  tokenAddress: string;
  escrowAddress: string;
  token: TestEUR | IERC20;
  escrow: SinettiEscrowV04;
  arbitrator: MockManualArbitrator | ConsoleArbitrator;
  labels: Map<string, string>;
  /** Deal amounts to use, already clamped to the escrow's caps in attached mode. */
  dealAmounts: { amount: bigint; bond: bigint; challengerBond: bigint };
  /** false: deployLocal() deployed fresh throwaway contracts, as always. true:
   *  attachRemote() attached to an already deployed escrow (SINETTI_ESCROW_ADDRESS). */
  attached: boolean;
};

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatValue(context: LocalContext, name: string, type: string, value: unknown): string {
  if (type === "address" && typeof value === "string") {
    const label = context.labels.get(value.toLowerCase());
    return label ? `${label} (${shortAddress(value)})` : shortAddress(value);
  }
  if (type === "bytes32" && typeof value === "string") {
    try {
      return `"${ethers.decodeBytes32String(value)}"`;
    } catch {
      return value;
    }
  }
  if (typeof value === "bigint") {
    if (["amount", "bond", "challengerBond", "sellerCredit", "buyerCredit", "value"].includes(name)) {
      return `${ethers.formatUnits(value, 6)} tEUR`;
    }
    return value.toString();
  }
  return String(value);
}

function parseLog(
  context: LocalContext,
  log: ContractTransactionReceipt["logs"][number]
): LogDescription | null {
  try {
    if (log.address.toLowerCase() === context.escrowAddress.toLowerCase()) {
      return context.escrow.interface.parseLog(log);
    }
    if (log.address.toLowerCase() === context.tokenAddress.toLowerCase()) {
      return context.token.interface.parseLog(log);
    }
  } catch {
    return null;
  }
  return null;
}

export async function send(
  context: LocalContext,
  label: string,
  transactionPromise: Promise<ContractTransactionResponse>
): Promise<ContractTransactionReceipt> {
  const transaction = await transactionPromise;
  const receipt = await transaction.wait();
  if (!receipt) throw new Error(`Transaction ${transaction.hash} was not mined`);

  console.log(`\n${label}`);
  console.log(`  tx: ${transaction.hash} (block ${receipt.blockNumber})`);
  for (const event of receipt.logs.map((log) => parseLog(context, log)).filter(Boolean) as LogDescription[]) {
    const fields = event.fragment.inputs.map((input, index) =>
      `${input.name}=${formatValue(context, input.name, input.type, event.args[index])}`
    );
    console.log(`  ${event.name}(${fields.join(", ")})`);
  }
  return receipt;
}

export async function deployLocal(): Promise<LocalContext> {
  if (networkName !== "default") {
    throw new Error(`Local examples only run on the in-process Hardhat network, not ${networkName}`);
  }

  const [deployer, buyer, seller, verifier] = await ethers.getSigners();
  const [deployerAddress, buyerAddress, sellerAddress, verifierAddress] = await Promise.all([
    deployer.getAddress(),
    buyer.getAddress(),
    seller.getAddress(),
    verifier.getAddress()
  ]);

  const token = await (await ethers.getContractFactory("TestEUR", deployer)).deploy();
  await token.waitForDeployment();
  const arbitrator = await (
    await ethers.getContractFactory("MockManualArbitrator", deployer)
  ).deploy();
  await arbitrator.waitForDeployment();
  const escrow = await (await ethers.getContractFactory("SinettiEscrowV04", deployer)).deploy(
    deployerAddress,
    [{
      token: await token.getAddress(),
      maxAmount: 1_000n * 10n ** 6n,
      maxBond: 500n * 10n ** 6n,
      minBondBps: 0,
      minChallengerBondBps: 0
    }],
    [],
    [],
    60,
    60
  );
  await escrow.waitForDeployment();

  const tokenAddress = await token.getAddress();
  const escrowAddress = await escrow.getAddress();
  const arbitratorAddress = await arbitrator.getAddress();
  const labels = new Map<string, string>([
    [deployerAddress.toLowerCase(), "deployer"],
    [buyerAddress.toLowerCase(), "buyer"],
    [sellerAddress.toLowerCase(), "seller"],
    [verifierAddress.toLowerCase(), "verifier"],
    [arbitratorAddress.toLowerCase(), "arbitrator"],
    [tokenAddress.toLowerCase(), "TestEUR"],
    [escrowAddress.toLowerCase(), "escrow"]
  ]);

  console.log("SinettiEscrowV04 local lifecycle");
  console.log("Network: hardhat (ephemeral, in-process, no keys or faucet required)");
  console.log(`TestEUR (tEUR): ${tokenAddress}`);
  console.log(`SinettiEscrowV04: ${escrowAddress}`);
  console.log(`MockManualArbitrator: ${arbitratorAddress}`);

  return {
    deployer,
    buyer,
    seller,
    verifier,
    buyerAddress,
    sellerAddress,
    verifierAddress,
    arbitratorAddress,
    tokenAddress,
    escrowAddress,
    token,
    escrow,
    arbitrator,
    labels,
    dealAmounts: { amount: AMOUNT, bond: BOND, challengerBond: CHALLENGER_BOND },
    attached: false
  };
}

/**
 * Attaches to an already deployed SinettiEscrowV04 instead of deploying one.
 * Signers come from BUYER_PRIVATE_KEY / SELLER_PRIVATE_KEY / VERIFIER_PRIVATE_KEY,
 * connected to Hardhat's configured network provider. No account is funded here:
 * requireFunded() checks native gas and token balances up front instead.
 */
export async function attachRemote(): Promise<LocalContext> {
  const escrowAddress = envAddress("SINETTI_ESCROW_ADDRESS");
  const arbitratorAddress = envAddress("SINETTI_ARBITRATOR_ADDRESS");
  const tokenAddress = envAddress("SINETTI_TOKEN_ADDRESS");

  const buyer = walletFromEnv("BUYER_PRIVATE_KEY");
  const seller = walletFromEnv("SELLER_PRIVATE_KEY");
  const verifier = walletFromEnv("VERIFIER_PRIVATE_KEY");
  const [buyerAddress, sellerAddress, verifierAddress] = await Promise.all([
    buyer.getAddress(),
    seller.getAddress(),
    verifier.getAddress()
  ]);

  const escrow = (await ethers.getContractAt("SinettiEscrowV04", escrowAddress)) as SinettiEscrowV04;
  const token = (await ethers.getContractAt("IERC20", tokenAddress)) as unknown as IERC20;
  // Typed loosely: the deployed arbitrator may be ConsoleArbitrator or any other
  // IArbitratorV04 implementation. Callers that need ConsoleArbitrator-specific
  // methods (propose/overturn/push) attach it themselves with that address.
  const arbitrator = (await ethers.getContractAt(
    "ConsoleArbitrator",
    arbitratorAddress
  )) as ConsoleArbitrator;

  // Refuse to touch a mismatched deployment before any approval is granted.
  const arbitratorEscrow = await arbitrator.escrow();
  if (arbitratorEscrow.toLowerCase() !== escrowAddress.toLowerCase()) {
    throw new Error(`SINETTI_ARBITRATOR_ADDRESS points at escrow ${arbitratorEscrow}, expected ${escrowAddress}.`);
  }
  if ((await escrow.maxAmountOf(tokenAddress)) === 0n) {
    throw new Error(`SINETTI_TOKEN_ADDRESS ${tokenAddress} has no policy on escrow ${escrowAddress}.`);
  }

  const dealAmounts = await attachedDealAmounts(escrow, tokenAddress, {
    amount: AMOUNT,
    bond: BOND,
    challengerBond: CHALLENGER_BOND
  });

  await requireFunded([
    // The buyer's minimum covers both opening the deal and, if the caller is
    // examples/dispute.ts, posting the challenger bond afterward.
    {
      label: "buyer",
      address: buyerAddress,
      token,
      minToken: dealAmounts.amount + dealAmounts.challengerBond
    },
    { label: "seller", address: sellerAddress, token, minToken: dealAmounts.bond },
    { label: "verifier", address: verifierAddress, token, minToken: 0n }
  ]);

  const labels = new Map<string, string>([
    [buyerAddress.toLowerCase(), "buyer"],
    [sellerAddress.toLowerCase(), "seller"],
    [verifierAddress.toLowerCase(), "verifier"],
    [arbitratorAddress.toLowerCase(), "arbitrator"],
    [tokenAddress.toLowerCase(), "token"],
    [escrowAddress.toLowerCase(), "escrow"]
  ]);

  console.log("SinettiEscrowV04 attached-mode lifecycle");
  console.log(`Network: ${networkName}`);
  console.log(`Token: ${tokenAddress}`);
  console.log(`SinettiEscrowV04: ${escrowAddress}`);
  console.log(`Arbitrator: ${arbitratorAddress}`);
  console.log(
    `Deal amounts (clamped to deployed caps): amount=${dealAmounts.amount} ` +
      `bond=${dealAmounts.bond} challengerBond=${dealAmounts.challengerBond}`
  );

  return {
    // No deployer signer exists in attached mode; the buyer stands in for the
    // one call (claimTimeout) that any account may make.
    deployer: buyer,
    buyer,
    seller,
    verifier,
    buyerAddress,
    sellerAddress,
    verifierAddress,
    arbitratorAddress,
    tokenAddress,
    escrowAddress,
    token,
    escrow,
    arbitrator,
    labels,
    dealAmounts,
    attached: true
  };
}

/** SINETTI_ESCROW_ADDRESS set: attach. Unset: deploy fresh, exactly as before. */
export async function resolveContext(): Promise<LocalContext> {
  return isAttached() ? attachRemote() : deployLocal();
}

export async function fundAndOpen(
  context: LocalContext,
  criteria: Record<string, unknown>,
  durationSeconds: bigint,
  windows?: { challengeWindow: bigint; rulingWindow: bigint }
): Promise<bigint> {
  const { amount, bond } = context.dealAmounts;
  if (!context.attached) {
    // Local mode: mint straight to the throwaway TestEUR the same as before.
    await send(context, "Mint settlement tokens to buyer", (context.token as TestEUR).mint(context.buyerAddress, amount));
    await send(context, "Mint bond tokens to seller", (context.token as TestEUR).mint(context.sellerAddress, bond));
  }
  await send(
    context,
    "Buyer approves escrow principal",
    context.token.connect(context.buyer).approve(context.escrowAddress, amount)
  );

  const termsHash = ethers.sha256(
    ethers.toUtf8Bytes(canonicalJson(criteria))
  );
  const dealId = await context.escrow.nextDealId();
  const latestBlock = await ethers.provider.getBlock("latest");
  if (!latestBlock) throw new Error("cannot read the chain head");
  const { terms, signature } = await signSellerAcceptance({
    escrowAddress: context.escrowAddress,
    provider: ethers.provider,
    sellerSigner: context.seller,
    buyer: context.buyerAddress,
    seller: context.sellerAddress,
    verifier: context.verifierAddress,
    arbitrator: context.arbitratorAddress,
    token: context.tokenAddress,
    amount,
    bond,
    challengerBond: context.dealAmounts.challengerBond,
    termsHash,
    duration: durationSeconds,
    openBy: BigInt(latestBlock.timestamp) + durationSeconds,
    ...(windows ?? {})
  });
  await send(
    context,
    "Buyer opens and funds deal",
    context.escrow.connect(context.buyer).openDeal(terms, signature)
  );
  return dealId;
}

export async function postBond(context: LocalContext, dealId: bigint): Promise<void> {
  const { bond } = context.dealAmounts;
  await send(
    context,
    "Seller approves bond",
    context.token.connect(context.seller).approve(context.escrowAddress, bond)
  );
  await send(
    context,
    "Seller posts bond",
    context.escrow.connect(context.seller).postBond(dealId)
  );
}

export function assertEqual(actual: bigint, expected: bigint, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}
