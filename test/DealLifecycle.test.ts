import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "./helpers/hardhat";
import { loadFixture, time } from "./helpers/hardhat";

import { STATE, openDeal, postBond } from "../src/dealClient";
import {
  acceptVerification,
  assertActionAllowed,
  recordVerification,
  submitDelivery,
  verdictFromName,
  withdrawCredit
} from "../src/dealLifecycle";
import { signSellerAcceptance } from "../src/sellerAcceptance";

const AMOUNT = 250_000_000n;
const BOND = 25_000_000n;
const CHALLENGER_BOND = 1_000_000n;

async function fixture() {
  const [owner, buyer, seller, verifier, agent, officer] = await ethers.getSigners();
  const token = (await (await ethers.getContractFactory("TestEUR"))
    .connect(owner)
    .deploy()) as Contract;
  await token.waitForDeployment();
  const escrow = (await (await ethers.getContractFactory("SinettiEscrowV04"))
    .connect(owner)
    .deploy(
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
  const arbitrator = (await (await ethers.getContractFactory("ConsoleArbitrator"))
    .connect(owner)
    .deploy(
      await escrow.getAddress(),
      await agent.getAddress(),
      await officer.getAddress(),
      86_400
    )) as Contract;
  await arbitrator.waitForDeployment();
  return { owner, buyer, seller, verifier, agent, officer, token, escrow, arbitrator };
}

async function opened() {
  const context = await fixture();
  await context.token.mint(await context.buyer.getAddress(), AMOUNT);
  await context.token.mint(await context.seller.getAddress(), BOND);
  const { terms, signature } = await signSellerAcceptance({
    escrowAddress: await context.escrow.getAddress(),
    provider: ethers.provider,
    sellerSigner: context.seller,
    buyer: await context.buyer.getAddress(),
    seller: await context.seller.getAddress(),
    verifier: await context.verifier.getAddress(),
    arbitrator: await context.arbitrator.getAddress(),
    token: await context.token.getAddress(),
    amount: AMOUNT,
    bond: BOND,
    challengerBond: CHALLENGER_BOND,
    termsHash: ethers.id("example terms"),
    duration: 7200n,
    challengeWindow: 60n,
    rulingWindow: 3600n,
    openBy: BigInt(await time.latest()) + 3600n
  });
  const result = await openDeal({
    escrowAddress: await context.escrow.getAddress(),
    buyerSigner: context.buyer,
    terms,
    signature
  });
  return { ...context, terms, dealId: result.dealId };
}

describe("V04 deal lifecycle client", function () {
  it("drives the happy path using getDeal state", async function () {
    const deal = await opened();
    const escrowAddress = await deal.escrow.getAddress();
    const tokenAddress = await deal.token.getAddress();

    const bond = await postBond({
      escrowAddress,
      sellerSigner: deal.seller,
      dealId: deal.dealId,
      token: tokenAddress,
      bond: BOND
    });
    expect(bond.state).to.equal(STATE.Funded);
    expect((await deal.escrow.getDeal(deal.dealId)).bondPosted).to.equal(true);

    const delivery = await submitDelivery({
      escrowAddress,
      sellerSigner: deal.seller,
      dealId: deal.dealId,
      evidenceHash: ethers.id("shipment")
    });
    expect(delivery.state).to.equal(STATE.Delivered);

    const verification = await recordVerification({
      escrowAddress,
      verifierSigner: deal.verifier,
      dealId: deal.dealId,
      verdict: verdictFromName("pass")
    });
    expect(verification.state).to.equal(STATE.Verified);

    const accepted = await acceptVerification({
      escrowAddress,
      buyerSigner: deal.buyer,
      dealId: deal.dealId
    });
    expect(accepted.state).to.equal(STATE.Released);

    const withdrawal = await withdrawCredit({
      escrowAddress,
      signer: deal.seller,
      tokenAddress
    });
    expect(withdrawal.amount).to.equal(AMOUNT + BOND);
  });

  it("refuses empty evidence and delivery before a required bond", async function () {
    const deal = await opened();
    const escrowAddress = await deal.escrow.getAddress();
    await expect(
      submitDelivery({
        escrowAddress,
        sellerSigner: deal.seller,
        dealId: deal.dealId,
        evidenceHash: ethers.ZeroHash
      })
    ).to.be.rejectedWith(/bond/i);

    await postBond({
      escrowAddress,
      sellerSigner: deal.seller,
      dealId: deal.dealId,
      token: await deal.token.getAddress(),
      bond: BOND
    });
    await expect(
      submitDelivery({
        escrowAddress,
        sellerSigner: deal.seller,
        dealId: deal.dealId,
        evidenceHash: ethers.ZeroHash
      })
    ).to.be.rejectedWith(/evidence hash is empty/i);
  });

  it("mirrors V04 action availability by state", function () {
    expect(() => assertActionAllowed("verify", STATE.Delivered)).to.not.throw();
    expect(() => assertActionAllowed("challenge", STATE.Verified)).to.not.throw();
    expect(() => assertActionAllowed("propose", STATE.Disputed)).to.not.throw();
    expect(() => assertActionAllowed("verify", STATE.Funded)).to.throw(/state Funded/i);
    expect(() => assertActionAllowed("challenge", STATE.Released)).to.throw(/settled/i);
  });
});
