import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "./helpers/hardhat";
import { time } from "./helpers/hardhat";

import { OUTCOME, STATE, VERDICT, openDeal, postBond } from "../src/dealClient";
import {
  challengeVerdict,
  overturnRuling,
  proposeRuling,
  pushRuling,
  recordVerification,
  submitDelivery
} from "../src/dealLifecycle";
import { signSellerAcceptance } from "../src/sellerAcceptance";

const AMOUNT = 250_000_000n;
const BOND = 25_000_000n;
const CHALLENGER_BOND = 1_000_000n;
const OVERRIDE_WINDOW = 86_400n;

async function verifiedDeal(verdict: number) {
  const [owner, buyer, seller, verifier, agent, officer, outsider] =
    await ethers.getSigners();
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
      OVERRIDE_WINDOW
    )) as Contract;
  await arbitrator.waitForDeployment();

  await token.mint(await buyer.getAddress(), AMOUNT + CHALLENGER_BOND);
  await token.mint(await seller.getAddress(), BOND + CHALLENGER_BOND);
  const { terms, signature } = await signSellerAcceptance({
    escrowAddress: await escrow.getAddress(),
    provider: ethers.provider,
    sellerSigner: seller,
    buyer: await buyer.getAddress(),
    seller: await seller.getAddress(),
    verifier: await verifier.getAddress(),
    arbitrator: await arbitrator.getAddress(),
    token: await token.getAddress(),
    amount: AMOUNT,
    bond: BOND,
    challengerBond: CHALLENGER_BOND,
    termsHash: ethers.id("example terms"),
    duration: 7200n,
    challengeWindow: 60n,
    rulingWindow: 172_800n,
    openBy: BigInt(await time.latest()) + 3600n
  });
  const { dealId } = await openDeal({
    escrowAddress: await escrow.getAddress(),
    buyerSigner: buyer,
    terms,
    signature
  });
  await postBond({
    escrowAddress: await escrow.getAddress(),
    sellerSigner: seller,
    dealId,
    token: await token.getAddress(),
    bond: BOND
  });
  await submitDelivery({
    escrowAddress: await escrow.getAddress(),
    sellerSigner: seller,
    dealId,
    evidenceHash: ethers.id("shipment")
  });
  await recordVerification({
    escrowAddress: await escrow.getAddress(),
    verifierSigner: verifier,
    dealId,
    verdict
  });
  return { buyer, seller, verifier, agent, officer, outsider, token, escrow, arbitrator, dealId };
}

describe("V04 dispute client", function () {
  it("approves exactly the buyer challenger bond, then proposes and pushes Refund", async function () {
    const deal = await verifiedDeal(VERDICT.Pass);
    const escrowAddress = await deal.escrow.getAddress();
    const tokenAddress = await deal.token.getAddress();
    const challenged = await challengeVerdict({
      escrowAddress,
      signer: deal.buyer,
      dealId: deal.dealId
    });
    expect(challenged.state).to.equal(STATE.Disputed);
    expect(
      await deal.token.allowance(await deal.buyer.getAddress(), escrowAddress)
    ).to.equal(0n);

    await proposeRuling({
      escrowAddress,
      arbitratorAddress: await deal.arbitrator.getAddress(),
      signer: deal.agent,
      dealId: deal.dealId,
      outcome: OUTCOME.Refund
    });
    await time.increase(OVERRIDE_WINDOW);
    const pushed = await pushRuling({
      escrowAddress,
      arbitratorAddress: await deal.arbitrator.getAddress(),
      signer: deal.outsider,
      dealId: deal.dealId
    });
    expect(pushed.state).to.equal(STATE.Refunded);
    expect(
      await deal.escrow.withdrawable(tokenAddress, await deal.buyer.getAddress())
    ).to.equal(AMOUNT + BOND + CHALLENGER_BOND);
  });

  it("lets the officer overturn the agent before permissionless push", async function () {
    const deal = await verifiedDeal(VERDICT.Fail);
    const escrowAddress = await deal.escrow.getAddress();
    const arbitratorAddress = await deal.arbitrator.getAddress();
    await challengeVerdict({ escrowAddress, signer: deal.seller, dealId: deal.dealId });
    await proposeRuling({
      escrowAddress,
      arbitratorAddress,
      signer: deal.agent,
      dealId: deal.dealId,
      outcome: OUTCOME.Refund
    });
    await overturnRuling({
      escrowAddress,
      arbitratorAddress,
      signer: deal.officer,
      dealId: deal.dealId,
      outcome: OUTCOME.Release
    });
    await time.increase(OVERRIDE_WINDOW);
    const pushed = await pushRuling({
      escrowAddress,
      arbitratorAddress,
      signer: deal.outsider,
      dealId: deal.dealId
    });
    expect(pushed.state).to.equal(STATE.Released);
  });

  it("selects the challenger from the stored verdict", async function () {
    const pass = await verifiedDeal(VERDICT.Pass);
    await expect(
      challengeVerdict({
        escrowAddress: await pass.escrow.getAddress(),
        signer: pass.seller,
        dealId: pass.dealId
      })
    ).to.be.rejectedWith(/only be challenged by the buyer/i);
  });
});
