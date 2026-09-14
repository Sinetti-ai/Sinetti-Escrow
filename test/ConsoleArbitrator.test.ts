import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "./helpers/hardhat";
import { loadFixture, time } from "./helpers/hardhat";
import { openDealWithSellerAcceptanceV04 } from "./helpers/sellerAcceptanceV04";

const TERMS_HASH = ethers.encodeBytes32String("criteria+mandate");
const EVIDENCE_HASH = ethers.encodeBytes32String("evidence of delivery");
const REASON_LAPSED = ethers.encodeBytes32String("ruling_lapsed");

const VERDICT = { Pass: 1n, Fail: 2n };
const OUTCOME = { Release: 1n, Refund: 2n };
const STATE = { None: 0n, Funded: 1n, Disputed: 4n, Released: 5n, Refunded: 6n };

const AMOUNT = 100_000n;
const BOND = 25_000n;
const CHALLENGER_BOND = 10_000n;
const DURATION = 7_200n;
const OVERRIDE_WINDOW = 86_400n;
// The signed ruling window must exceed the Console's internal ladder (proposal
// latency + override window), or the escrow's lapse fallback fires first.
const RULING_WINDOW = 172_800n;

async function fixture() {
  const [owner, buyer, seller, verifier, agent, officer, other] =
    await ethers.getSigners();

  const mockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const mockUSDC = (await mockUSDCFactory.connect(owner).deploy()) as Contract;
  await mockUSDC.waitForDeployment();

  const escrowFactory = await ethers.getContractFactory("SinettiEscrowV04");
  const escrow = (await escrowFactory.connect(owner).deploy(
    await owner.getAddress(),
    [
      {
        token: await mockUSDC.getAddress(),
        maxAmount: ethers.MaxUint256,
        maxBond: ethers.MaxUint256,
        minBondBps: 0,
        minChallengerBondBps: 0
      }
    ],
    [],
    []
  , 60, 60)) as Contract;
  await escrow.waitForDeployment();

  const consoleFactory = await ethers.getContractFactory("ConsoleArbitrator");
  const consoleArbitrator = (await consoleFactory.connect(owner).deploy(
    await escrow.getAddress(),
    await agent.getAddress(),
    await officer.getAddress(),
    OVERRIDE_WINDOW
  )) as Contract;
  await consoleArbitrator.waitForDeployment();

  for (const [party, funds] of [
    [buyer, AMOUNT * 4n],
    [seller, BOND * 4n]
  ] as const) {
    await mockUSDC.mint(await party.getAddress(), funds);
    await mockUSDC.connect(party).approve(await escrow.getAddress(), funds);
  }

  return {
    owner, buyer, seller, verifier, agent, officer, other,
    mockUSDC, escrow, consoleArbitrator
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function openFundedDeal(
  f: Fixture,
  arbitratorAddress?: string,
  rulingWindow = RULING_WINDOW
): Promise<bigint> {
  await openDealWithSellerAcceptanceV04(
    f.escrow,
    f.buyer,
    f.seller,
    await f.seller.getAddress(),
    await f.verifier.getAddress(),
    arbitratorAddress ?? await f.consoleArbitrator.getAddress(),
    f.mockUSDC,
    AMOUNT,
    BOND,
    CHALLENGER_BOND,
    TERMS_HASH,
    DURATION,
    { rulingWindow }
  );
  return (await f.escrow.nextDealId()) - 1n;
}

async function openDisputedDeal(
  f: Fixture,
  verdict: bigint,
  arbitratorAddress?: string,
  rulingWindow = RULING_WINDOW
): Promise<bigint> {
  const dealId = await openFundedDeal(f, arbitratorAddress, rulingWindow);
  await f.escrow.connect(f.seller).postBond(dealId);
  await f.escrow.connect(f.seller).submitDelivery(dealId, EVIDENCE_HASH);
  await f.escrow.connect(f.verifier).recordVerification(dealId, verdict);
  const challenger = verdict === VERDICT.Pass ? f.buyer : f.seller;
  await f.escrow.connect(challenger).challenge(dealId);
  return dealId;
}

describe("ConsoleArbitrator", function () {
  it("constructor pins the wiring and rejects zero addresses; marker view answers", async function () {
    const f = await loadFixture(fixture);
    expect(await f.consoleArbitrator.escrow()).to.equal(await f.escrow.getAddress());
    expect(await f.consoleArbitrator.agentKey()).to.equal(await f.agent.getAddress());
    expect(await f.consoleArbitrator.officer()).to.equal(await f.officer.getAddress());
    expect(await f.consoleArbitrator.overrideWindow()).to.equal(OVERRIDE_WINDOW);
    expect(await f.consoleArbitrator.MIN_PUSH_BUFFER()).to.equal(3600n);
    expect(await f.consoleArbitrator.ARBITRATOR_MARKER()).to.equal(
      ethers.keccak256(ethers.toUtf8Bytes("sinetti.arbitrator.v04"))
    );

    const factory = await ethers.getContractFactory("ConsoleArbitrator");
    await expect(
      factory.deploy(ethers.ZeroAddress, await f.agent.getAddress(), await f.officer.getAddress(), 1n)
    ).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  it("requires between one and thirty days for human review", async function () {
    const f = await loadFixture(fixture);
    const factory = await ethers.getContractFactory("ConsoleArbitrator");
    const minOverride = await f.consoleArbitrator.MIN_OVERRIDE_WINDOW();
    const maxOverride = await f.consoleArbitrator.MAX_OVERRIDE_WINDOW();
    expect(minOverride).to.equal(86400n);
    expect(maxOverride).to.equal(30n * 86400n);

    await expect(
      factory.deploy(
        await f.escrow.getAddress(),
        await f.agent.getAddress(),
        await f.officer.getAddress(),
        minOverride - 1n
      )
    ).to.be.revertedWithCustomError(factory, "OverrideWindowTooShort");

    // Above the bound the veto clock could outlast the escrow's lapse fallback,
    // or overflow proposedAt + overrideWindow into a panic. Both are silent
    // traps rather than fund risks, so the constructor refuses them outright.
    await expect(
      factory.deploy(
        await f.escrow.getAddress(),
        await f.agent.getAddress(),
        await f.officer.getAddress(),
        maxOverride + 1n
      )
    ).to.be.revertedWithCustomError(factory, "OverrideWindowTooLong");

    const atBound = await factory.deploy(
      await f.escrow.getAddress(),
      await f.agent.getAddress(),
      await f.officer.getAddress(),
      maxOverride
    );
    await atBound.waitForDeployment();
    expect(await atBound.overrideWindow()).to.equal(maxOverride);
  });

  it("branch 1 - the agent rules and stands: proposal pushes to the escrow after the override window", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDisputedDeal(f, VERDICT.Pass);

    await expect(f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Release))
      .to.emit(f.consoleArbitrator, "RulingProposed");
    await expect(
      f.consoleArbitrator.connect(f.other).push(dealId)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "OverrideWindowOpen");

    await time.increase(OVERRIDE_WINDOW);
    await expect(f.consoleArbitrator.connect(f.other).push(dealId))
      .to.emit(f.consoleArbitrator, "RulingPushed")
      .withArgs(dealId, OUTCOME.Release);
    expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Released);
  });

  it("refuses to start a proposal unless review and relay fit before the live deadline", async function () {
    const f = await loadFixture(fixture);
    const minimumNominalWindow = OVERRIDE_WINDOW + await f.consoleArbitrator.MIN_PUSH_BUFFER();
    const dealId = await openDisputedDeal(
      f,
      VERDICT.Pass,
      undefined,
      minimumNominalWindow
    );
    const dispute = await f.escrow.disputes(dealId);

    await expect(
      f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Release)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "InsufficientRulingTime");
    expect((await f.consoleArbitrator.proposals(dealId)).proposedAt).to.equal(0n);
    expect(dispute.rulingDeadline).to.be.greaterThan(0n);
  });

  it("rejects proposals before a deal exists or enters Disputed without starting the officer clock", async function () {
    const f = await loadFixture(fixture);
    const futureId = await f.escrow.nextDealId();

    await expect(
      f.consoleArbitrator.connect(f.agent).propose(futureId, OUTCOME.Release)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "DealNotDisputed")
      .withArgs(futureId, STATE.None);
    expect((await f.consoleArbitrator.proposals(futureId)).proposedAt).to.equal(0n);

    const fundedId = await openFundedDeal(f);
    await expect(
      f.consoleArbitrator.connect(f.agent).propose(fundedId, OUTCOME.Release)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "DealNotDisputed")
      .withArgs(fundedId, STATE.Funded);
    expect((await f.consoleArbitrator.proposals(fundedId)).proposedAt).to.equal(0n);
  });

  it("rejects a disputed deal that names a different arbitrator", async function () {
    const f = await loadFixture(fixture);
    const factory = await ethers.getContractFactory("ConsoleArbitrator");
    const otherArbitrator = await factory.deploy(
      await f.escrow.getAddress(),
      await f.agent.getAddress(),
      await f.officer.getAddress(),
      OVERRIDE_WINDOW
    );
    await otherArbitrator.waitForDeployment();
    const otherAddress = await otherArbitrator.getAddress();
    const dealId = await openDisputedDeal(f, VERDICT.Pass, otherAddress);

    await expect(
      f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Release)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "DealUsesDifferentArbitrator")
      .withArgs(dealId, otherAddress);
    expect((await f.consoleArbitrator.proposals(dealId)).proposedAt).to.equal(0n);
  });

  it("branch 2 - the officer overturns inside the window: the reversal is what lands", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDisputedDeal(f, VERDICT.Pass);

    await f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Release);
    await expect(f.consoleArbitrator.connect(f.officer).overturn(dealId, OUTCOME.Refund))
      .to.emit(f.consoleArbitrator, "RulingOverturned")
      .withArgs(dealId, OUTCOME.Refund);

    await time.increase(OVERRIDE_WINDOW);
    await f.consoleArbitrator.push(dealId);
    expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Refunded);
  });

  it("branch 3 - the officer is one second too late: the agent's ruling stands", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDisputedDeal(f, VERDICT.Pass);

    await f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Release);
    const proposal = await f.consoleArbitrator.proposals(dealId);
    await time.increaseTo(proposal.proposedAt + OVERRIDE_WINDOW);
    await expect(
      f.consoleArbitrator.connect(f.officer).overturn(dealId, OUTCOME.Refund)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "OverrideWindowClosed");
    await f.consoleArbitrator.push(dealId);
    expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Released);
  });

  it("branch 4 - the agent never rules: the escrow's lapse fallback settles the deal", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDisputedDeal(f, VERDICT.Pass);

    await time.increase(RULING_WINDOW + 1n);
    await expect(f.escrow.finalize(dealId))
      .to.emit(f.escrow, "Settled")
      .withArgs(dealId, REASON_LAPSED, AMOUNT + BOND, CHALLENGER_BOND);

    // A terminal deal cannot start a fresh officer window.
    await expect(
      f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Refund)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "DealNotDisputed")
      .withArgs(dealId, STATE.Released);
    expect((await f.consoleArbitrator.proposals(dealId)).proposedAt).to.equal(0n);
  });

  it("guards: wrong callers, invalid outcomes, double proposal, double push, push without proposal", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDisputedDeal(f, VERDICT.Fail);

    await expect(
      f.consoleArbitrator.connect(f.other).propose(dealId, OUTCOME.Release)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "NotAgent");
    await expect(
      f.consoleArbitrator.connect(f.agent).propose(dealId, 0n)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "InvalidOutcome");
    await expect(
      f.consoleArbitrator.connect(f.officer).overturn(dealId, OUTCOME.Refund)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "NothingProposed");
    await expect(f.consoleArbitrator.push(dealId)).to.be.revertedWithCustomError(
      f.consoleArbitrator,
      "NothingProposed"
    );

    await f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Release);
    await expect(
      f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Refund)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "AlreadyProposed");
    await expect(
      f.consoleArbitrator.connect(f.agent).overturn(dealId, OUTCOME.Refund)
    ).to.be.revertedWithCustomError(f.consoleArbitrator, "NotOfficer");

    await time.increase(OVERRIDE_WINDOW);
    await f.consoleArbitrator.push(dealId);
    await expect(f.consoleArbitrator.push(dealId)).to.be.revertedWithCustomError(
      f.consoleArbitrator,
      "AlreadyPushed"
    );
    expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Released);
  });

  it("branch 5 - the officer rules outright: no proposal, no window, the escrow settles now", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDisputedDeal(f, VERDICT.Pass);

    await expect(f.consoleArbitrator.connect(f.officer).rule(dealId, OUTCOME.Refund))
      .to.emit(f.consoleArbitrator, "OfficerRuled").withArgs(dealId, OUTCOME.Refund)
      .and.to.emit(f.consoleArbitrator, "RulingPushed").withArgs(dealId, OUTCOME.Refund);
    expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Refunded);

    const proposal = await f.consoleArbitrator.proposals(dealId);
    expect(proposal.pushed).to.equal(true);
    await expect(f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Release))
      .to.be.revertedWithCustomError(f.consoleArbitrator, "AlreadyProposed");
  });

  it("branch 6 - the agent proposes and the officer confirms early: lands inside the window", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDisputedDeal(f, VERDICT.Pass);
    await f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Release);
    await time.increase(60);

    await expect(f.consoleArbitrator.connect(f.officer).rule(dealId, OUTCOME.Release))
      .to.emit(f.consoleArbitrator, "RulingPushed").withArgs(dealId, OUTCOME.Release);
    expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Released);

    await time.increase(OVERRIDE_WINDOW);
    await expect(f.consoleArbitrator.connect(f.buyer).push(dealId))
      .to.be.revertedWithCustomError(f.consoleArbitrator, "AlreadyPushed");
    await expect(f.consoleArbitrator.connect(f.officer).rule(dealId, OUTCOME.Refund))
      .to.be.revertedWithCustomError(f.consoleArbitrator, "AlreadyPushed");
  });

  it("rule guards: only the officer, valid outcomes, and only a live disputed deal", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDisputedDeal(f, VERDICT.Pass);

    await expect(f.consoleArbitrator.connect(f.agent).rule(dealId, OUTCOME.Refund))
      .to.be.revertedWithCustomError(f.consoleArbitrator, "NotOfficer");
    await expect(f.consoleArbitrator.connect(f.officer).rule(dealId, 3n))
      .to.be.revertedWithCustomError(f.consoleArbitrator, "InvalidOutcome");
    const fundedId = await openFundedDeal(f);
    await expect(f.consoleArbitrator.connect(f.officer).rule(fundedId, OUTCOME.Refund))
      .to.be.revertedWithCustomError(f.escrow, "DealNotDisputed");
    expect((await f.consoleArbitrator.proposals(fundedId)).pushed).to.equal(false);
  });

  it("the officer may re-overturn within the window; the last decision stands", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDisputedDeal(f, VERDICT.Fail);

    await f.consoleArbitrator.connect(f.agent).propose(dealId, OUTCOME.Refund);
    await f.consoleArbitrator.connect(f.officer).overturn(dealId, OUTCOME.Release);
    await f.consoleArbitrator.connect(f.officer).overturn(dealId, OUTCOME.Refund);
    await time.increase(OVERRIDE_WINDOW);
    await f.consoleArbitrator.push(dealId);
    expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Refunded);
  });
});
