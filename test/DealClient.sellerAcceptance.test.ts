import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "./helpers/hardhat";
import { time } from "./helpers/hardhat";

import {
  SELLER_ACCEPTANCE_TYPES,
  SIGNING_DOMAIN_NAME,
  SIGNING_DOMAIN_VERSION,
  buildSellerAcceptanceDomain,
  signSellerAcceptance
} from "../src/sellerAcceptance";
import { SELLER_ACCEPTANCE_V04_TYPES } from "./helpers/sellerAcceptanceV04";

async function fixture() {
  const [owner, buyer, seller, verifier, agent, officer] = await ethers.getSigners();
  const token = (await (await ethers.getContractFactory("TestEUR")).deploy()) as Contract;
  await token.waitForDeployment();
  const escrow = (await (await ethers.getContractFactory("SinettiEscrowV04")).deploy(
    await owner.getAddress(),
    [{
      token: await token.getAddress(),
      maxAmount: ethers.MaxUint256,
      maxBond: ethers.MaxUint256,
      minBondBps: 0,
      minChallengerBondBps: 0
    }],
    [],
    [],
    60,
    60
  )) as Contract;
  await escrow.waitForDeployment();
  const arbitrator = (await (await ethers.getContractFactory("ConsoleArbitrator")).deploy(
    await escrow.getAddress(),
    await agent.getAddress(),
    await officer.getAddress(),
    86_400
  )) as Contract;
  await arbitrator.waitForDeployment();
  return { buyer, seller, verifier, token, escrow, arbitrator };
}

describe("deal client — V04 seller acceptance", function () {
  it("matches the authoritative helper field-for-field", function () {
    expect(SELLER_ACCEPTANCE_TYPES).to.deep.equal(SELLER_ACCEPTANCE_V04_TYPES);
  });

  it("reads and enforces the declared name and version 8 domain", async function () {
    const { escrow } = await fixture();
    const domain = await buildSellerAcceptanceDomain(
      await escrow.getAddress(),
      ethers.provider
    );
    expect(domain.name).to.equal(SIGNING_DOMAIN_NAME);
    expect(domain.version).to.equal(SIGNING_DOMAIN_VERSION);
  });

  it("refuses a well-formed domain with stale version 6", async function () {
    const factory = await ethers.getContractFactory("ConfigurableDomainDeclarer");
    const declarer = await factory.deploy(
      "0x0f",
      "SinettiEscrow",
      "6",
      31337,
      ethers.ZeroAddress,
      ethers.ZeroHash
    );
    await declarer.waitForDeployment();
    await expect(
      buildSellerAcceptanceDomain(await declarer.getAddress(), ethers.provider)
    ).to.be.rejectedWith(/version "6".*requires.*version "8"/i);
  });

  it("refuses a well-formed domain with a chainId different from the connection", async function () {
    const factory = await ethers.getContractFactory("ConfigurableDomainDeclarer");
    const declarer = await factory.deploy(
      "0x0f",
      "SinettiEscrow",
      "8",
      31338,
      ethers.ZeroAddress,
      ethers.ZeroHash
    );
    await declarer.waitForDeployment();
    await expect(
      buildSellerAcceptanceDomain(await declarer.getAddress(), ethers.provider)
    ).to.be.rejectedWith(/declares.*chainId 31338.*connection.*31337.*well-formed signature/i);
  });

  it("returns the exact 19-field terms object and the escrow accepts it", async function () {
    const context = await fixture();
    const amount = 250_000_000n;
    await context.token.mint(await context.buyer.getAddress(), amount);
    await context.token.connect(context.buyer).approve(await context.escrow.getAddress(), amount);
    const { terms, signature } = await signSellerAcceptance({
      escrowAddress: await context.escrow.getAddress(),
      provider: ethers.provider,
      sellerSigner: context.seller,
      buyer: await context.buyer.getAddress(),
      seller: await context.seller.getAddress(),
      verifier: await context.verifier.getAddress(),
      arbitrator: await context.arbitrator.getAddress(),
      token: await context.token.getAddress(),
      amount,
      bond: 0n,
      challengerBond: 1_000_000n,
      termsHash: ethers.id("example terms"),
      duration: 7200n,
      challengeWindow: 3600n,
      rulingWindow: 86400n,
      openBy: BigInt(await time.latest()) + 3600n,
      metaEvidenceURI: "ipfs://example-evidence"
    });
    expect(Object.keys(terms)).to.deep.equal(
      SELLER_ACCEPTANCE_TYPES.SellerAcceptance.map((field) => field.name)
    );
    await expect(context.escrow.connect(context.buyer).openDeal(terms, signature))
      .to.emit(context.escrow, "DealOpened")
      .and.to.emit(context.escrow, "MetaEvidence");
  });

  it("keeps the ERC-5267 fields-bitmap guard", async function () {
    const factory = await ethers.getContractFactory("ConfigurableDomainDeclarer");
    const declarer = await factory.deploy(
      "0x1f",
      "SinettiEscrow",
      "8",
      31337,
      ethers.ZeroAddress,
      ethers.id("salt")
    );
    await declarer.waitForDeployment();
    await expect(
      buildSellerAcceptanceDomain(await declarer.getAddress(), ethers.provider)
    ).to.be.rejectedWith(/salt/i);
  });
});
