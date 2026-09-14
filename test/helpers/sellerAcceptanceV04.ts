import type {
  Addressable,
  BigNumberish,
  ContractTransactionResponse,
  Signer,
  TypedDataField
} from "ethers";
import { ethers } from "./hardhat";

let benchmarkSaltSequence = 0n;

type SellerAcceptanceV04Options = {
  deterministicBenchmarkSalt?: boolean;
  challengeWindow?: BigNumberish;
  rulingWindow?: BigNumberish;
  challengerBond?: BigNumberish;
  buyerIdentityRef?: string;
  sellerIdentityRef?: string;
  verifierIdentityRef?: string;
  arbitratorIdentityRef?: string;
  metaEvidenceURI?: string;
  openBy?: BigNumberish;
};

export const DEFAULT_CHALLENGE_WINDOW = 3600n;
export const DEFAULT_RULING_WINDOW = 86400n;
export const SIGNING_DOMAIN_VERSION = "8";
export const ZERO_REF = ethers.ZeroHash;

/** The EIP-712 domain every V04 signature uses; single source of truth. */
export function signingDomain(chainId: BigNumberish, verifyingContract: string) {
  return {
    name: "SinettiEscrow",
    version: SIGNING_DOMAIN_VERSION,
    chainId,
    verifyingContract
  };
}

export const CANCELLATION_OFFER_TYPES: Record<string, TypedDataField[]> = {
  CancellationOffer: [
    { name: "dealId", type: "uint256" },
    { name: "signer", type: "address" },
    { name: "revision", type: "uint32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiry", type: "uint64" }
  ]
};

export const SELLER_ACCEPTANCE_V04_TYPES: Record<string, TypedDataField[]> = {
  SellerAcceptance: [
    { name: "buyer", type: "address" },
    { name: "seller", type: "address" },
    { name: "verifier", type: "address" },
    { name: "arbitrator", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "bond", type: "uint256" },
    { name: "challengerBond", type: "uint256" },
    { name: "termsHash", type: "bytes32" },
    { name: "buyerIdentityRef", type: "bytes32" },
    { name: "sellerIdentityRef", type: "bytes32" },
    { name: "verifierIdentityRef", type: "bytes32" },
    { name: "arbitratorIdentityRef", type: "bytes32" },
    { name: "duration", type: "uint64" },
    { name: "challengeWindow", type: "uint64" },
    { name: "rulingWindow", type: "uint64" },
    { name: "openBy", type: "uint64" },
    { name: "salt", type: "bytes32" },
    { name: "metaEvidenceURI", type: "string" }
  ]
};

type EscrowLike = {
  getAddress(): Promise<string>;
};

export type SignedAcceptanceV04 = {
  acceptance: {
    buyer: string;
    seller: string;
    verifier: string;
    arbitrator: string;
    token: string;
    amount: BigNumberish;
    bond: BigNumberish;
    challengerBond: BigNumberish;
    termsHash: string;
    buyerIdentityRef: string;
    sellerIdentityRef: string;
    verifierIdentityRef: string;
    arbitratorIdentityRef: string;
    duration: BigNumberish;
    challengeWindow: BigNumberish;
    rulingWindow: BigNumberish;
    openBy: BigNumberish;
    salt: string;
    metaEvidenceURI: string;
  };
  signature: string;
};

export async function sellerAcceptanceV04(
  escrow: EscrowLike,
  chainId: BigNumberish,
  sellerSigner: Signer,
  buyer: string,
  seller: string,
  verifier: string,
  arbitrator: string,
  token: string,
  amount: BigNumberish,
  bond: BigNumberish,
  challengerBond: BigNumberish,
  termsHash: string,
  duration: BigNumberish,
  openBy: BigNumberish,
  options: SellerAcceptanceV04Options = {}
): Promise<SignedAcceptanceV04> {
  const verifyingContract = await escrow.getAddress();
  const salt = options.deterministicBenchmarkSalt
    ? ethers.zeroPadValue(ethers.toBeHex(benchmarkSaltSequence++), 32)
    : ethers.hexlify(ethers.randomBytes(32));
  const acceptance = {
    buyer,
    seller,
    verifier,
    arbitrator,
    token,
    amount,
    bond,
    challengerBond,
    termsHash,
    buyerIdentityRef: options.buyerIdentityRef ?? ZERO_REF,
    sellerIdentityRef: options.sellerIdentityRef ?? ZERO_REF,
    verifierIdentityRef: options.verifierIdentityRef ?? ZERO_REF,
    arbitratorIdentityRef: options.arbitratorIdentityRef ?? ZERO_REF,
    duration,
    challengeWindow: options.challengeWindow ?? DEFAULT_CHALLENGE_WINDOW,
    rulingWindow: options.rulingWindow ?? DEFAULT_RULING_WINDOW,
    openBy,
    salt,
    metaEvidenceURI: options.metaEvidenceURI ?? ""
  };
  const domain = signingDomain(chainId, verifyingContract);
  const signature = await sellerSigner.signTypedData(
    domain,
    SELLER_ACCEPTANCE_V04_TYPES,
    acceptance
  );

  return { acceptance, signature };
}

export async function openDealWithSellerAcceptanceV04(
  escrow: any,
  buyerSigner: Signer,
  sellerSigner: Signer,
  seller: string,
  verifier: string,
  arbitrator: string,
  token: string | Addressable,
  amount: BigNumberish,
  bond: BigNumberish,
  challengerBond: BigNumberish,
  termsHash: string,
  duration: BigNumberish,
  options: SellerAcceptanceV04Options = {}
): Promise<ContractTransactionResponse> {
  const provider = escrow.runner?.provider;
  if (!provider) throw new Error("Escrow contract is not connected to a provider");

  const [buyer, tokenAddress, { chainId }, latestBlock] = await Promise.all([
    buyerSigner.getAddress(),
    typeof token === "string" ? token : token.getAddress(),
    provider.getNetwork(),
    provider.getBlock("latest")
  ]);
  const openBy =
    options.openBy ?? BigInt(latestBlock!.timestamp) + BigInt(duration.toString());
  const { acceptance, signature } = await sellerAcceptanceV04(
    escrow,
    chainId,
    sellerSigner,
    buyer,
    seller,
    verifier,
    arbitrator,
    tokenAddress,
    amount,
    bond,
    challengerBond,
    termsHash,
    duration,
    openBy,
    options
  );

  return escrow.connect(buyerSigner).openDeal(acceptance, signature);
}
