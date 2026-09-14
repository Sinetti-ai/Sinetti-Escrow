import { expect } from "chai";
import { Contract, EventLog, Signer } from "ethers";
import { ethers } from "./helpers/hardhat";
import { loadFixture, time } from "./helpers/hardhat";
import {
  openDealWithSellerAcceptanceV04,
  DEFAULT_CHALLENGE_WINDOW,
  DEFAULT_RULING_WINDOW
} from "./helpers/sellerAcceptanceV04";

/**
 * Enforced mechanically: for every terminal path, an indexer
 * reading nothing but events must reconstruct the full payout (who is credited
 * what, and why) with zero contract state reads, and that reconstruction must
 * match both the design's settlement matrix and the actual on-chain credits.
 */

const TERMS_HASH = ethers.encodeBytes32String("criteria+mandate");
const EVIDENCE_HASH = ethers.encodeBytes32String("evidence of delivery");

const AMOUNT = 100_000n;
const BOND = 25_000n;
const CHALLENGER_BOND = 10_000n;
const DURATION = 7_200n;

const VERDICT = { Pass: 1n, Fail: 2n, Inconclusive: 3n };
const OUTCOME = { Release: 1n, Refund: 2n };

type EventRecord = { name: string; args: Record<string, unknown> };

async function fixture() {
  const [owner, buyer, seller, verifier, other] = await ethers.getSigners();

  const mockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const mockUSDC = (await mockUSDCFactory.connect(owner).deploy()) as Contract;
  await mockUSDC.waitForDeployment();

  const arbitratorFactory = await ethers.getContractFactory("MockManualArbitrator");
  const arbitrator = (await arbitratorFactory.connect(owner).deploy()) as Contract;
  await arbitrator.waitForDeployment();

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

  for (const [party, funds] of [
    [buyer, AMOUNT * 20n],
    [seller, BOND * 20n]
  ] as const) {
    await mockUSDC.mint(await party.getAddress(), funds);
    await mockUSDC.connect(party).approve(await escrow.getAddress(), funds);
  }

  return { owner, buyer, seller, verifier, other, mockUSDC, arbitrator, escrow };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Pull every escrow event for one deal, as plain data - the indexer's view. */
async function eventsForDeal(escrow: Contract, dealId: bigint): Promise<EventRecord[]> {
  const logs = await escrow.queryFilter("*", 0, "latest");
  const records: EventRecord[] = [];
  for (const log of logs) {
    if (!(log instanceof EventLog)) continue;
    const args = log.args.toObject();
    if ("dealId" in args && args.dealId !== dealId) continue;
    if (!("dealId" in args)) continue;
    records.push({ name: log.fragment.name, args });
  }
  return records;
}

/**
 * The independent replayer: derives the expected payouts for a deal FROM ITS
 * Events only, re-implementing the settlement matrix in plain code.
 * It never touches the contract.
 */
function replayFromEvents(events: EventRecord[]) {
  const opened = events.find((e) => e.name === "DealOpened");
  if (!opened) throw new Error("no DealOpened event");
  const amount = opened.args.amount as bigint;
  const signedBond = opened.args.bond as bigint;
  const challengerBond = opened.args.challengerBond as bigint;
  const buyer = opened.args.buyer as string;
  const seller = opened.args.seller as string;

  const bondPosted = events.some((e) => e.name === "BondPosted");
  const postedBond = bondPosted ? signedBond : 0n;
  const challenged = events.find((e) => e.name === "Challenged");
  const challengerIsBuyer = challenged ? challenged.args.challenger === buyer : false;

  const settled = events.find((e) => e.name === "Settled");
  if (!settled) throw new Error("no Settled event");
  const reason = ethers.decodeBytes32String(settled.args.reason as string);

  let sellerCredit: bigint;
  let buyerCredit: bigint;
  switch (reason) {
    case "accepted":
    case "verdict_pass":
      sellerCredit = amount + postedBond;
      buyerCredit = 0n;
      break;
    case "verdict_fail":
    case "verdict_inconclusive":
    case "timeout":
      sellerCredit = postedBond;
      buyerCredit = amount;
      break;
    case "ruling_release":
      sellerCredit = amount + postedBond + challengerBond;
      buyerCredit = 0n;
      break;
    case "ruling_refund":
      sellerCredit = 0n;
      buyerCredit = amount + postedBond + challengerBond;
      break;
    case "ruling_lapsed": {
      const verdictEvent = events.find((e) => e.name === "VerificationRecorded");
      const pass = verdictEvent!.args.verdict === VERDICT.Pass;
      sellerCredit = pass
        ? amount + postedBond
        : postedBond + (challengerIsBuyer ? 0n : challengerBond);
      buyerCredit = pass ? (challengerIsBuyer ? challengerBond : 0n) : amount;
      break;
    }
    case "cancelled":
      sellerCredit =
        postedBond + (challenged && !challengerIsBuyer ? challengerBond : 0n);
      buyerCredit = amount + (challenged && challengerIsBuyer ? challengerBond : 0n);
      break;
    default:
      throw new Error(`unknown settlement reason: ${reason}`);
  }

  const custody = amount + postedBond + (challenged ? challengerBond : 0n);
  const slashEvent = events.find((e) => e.name === "BondSlashed");
  return {
    reason,
    buyer,
    seller,
    sellerCredit,
    buyerCredit,
    custody,
    slashed: slashEvent ? (slashEvent.args.bond as bigint) : 0n,
    reportedSellerCredit: settled.args.sellerCredit as bigint,
    reportedBuyerCredit: settled.args.buyerCredit as bigint
  };
}

async function verifyReconstruction(f: Fixture, dealId: bigint) {
  const events = await eventsForDeal(f.escrow, dealId);
  const replay = replayFromEvents(events);

  // 1. The event-only replay agrees with what the contract reported in Settled.
  expect(replay.sellerCredit, "seller credit vs Settled").to.equal(
    replay.reportedSellerCredit
  );
  expect(replay.buyerCredit, "buyer credit vs Settled").to.equal(
    replay.reportedBuyerCredit
  );
  // 2. Conservation from events alone: credits equal custody.
  expect(replay.sellerCredit + replay.buyerCredit, "conservation").to.equal(
    replay.custody
  );
  // 3. The replay agrees with the contract's actual credit books.
  const tokenAddress = await f.mockUSDC.getAddress();
  // (Credits accumulate across deals in a shared fixture, so each path test uses
  // a fresh fixture: withdrawable == this deal's credits.)
  expect(await f.escrow.withdrawable(tokenAddress, replay.seller)).to.equal(
    replay.sellerCredit
  );
  expect(await f.escrow.withdrawable(tokenAddress, replay.buyer)).to.equal(
    replay.buyerCredit
  );
  return replay;
}

async function openDeal(f: Fixture, withBond = true): Promise<bigint> {
  await openDealWithSellerAcceptanceV04(
    f.escrow,
    f.buyer,
    f.seller,
    await f.seller.getAddress(),
    await f.verifier.getAddress(),
    await f.arbitrator.getAddress(),
    f.mockUSDC,
    AMOUNT,
    withBond ? BOND : 0n,
    CHALLENGER_BOND,
    TERMS_HASH,
    DURATION
  );
  const dealId = (await f.escrow.nextDealId()) - 1n;
  if (withBond) {
    await f.escrow.connect(f.seller).postBond(dealId);
  }
  return dealId;
}

async function deliverAndVerify(f: Fixture, dealId: bigint, verdict: bigint) {
  await f.escrow.connect(f.seller).submitDelivery(dealId, EVIDENCE_HASH);
  await f.escrow.connect(f.verifier).recordVerification(dealId, verdict);
}

async function signCancellation(f: Fixture, signer: Signer, dealId: bigint) {
  const revision = (await f.escrow.getDeal(dealId)).revision;
  const now = BigInt(await time.latest());
  const offer = {
    dealId,
    signer: await signer.getAddress(),
    revision,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
    issuedAt: now,
    expiry: now + 1800n
  };
  const signature = await signer.signTypedData(
    {
      name: "SinettiEscrow",
      version: "8",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await f.escrow.getAddress()
    },
    {
      CancellationOffer: [
        { name: "dealId", type: "uint256" },
        { name: "signer", type: "address" },
        { name: "revision", type: "uint32" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiry", type: "uint64" }
      ]
    },
    offer
  );
  return { offer, signature };
}

describe("SinettiEscrowV04 events-only reconstruction", function () {
  it("path: accepted", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDeal(f);
    await deliverAndVerify(f, dealId, VERDICT.Pass);
    await f.escrow.connect(f.buyer).accept(dealId);
    const replay = await verifyReconstruction(f, dealId);
    expect(replay.reason).to.equal("accepted");
  });

  it("path: verdict_pass (unchallenged finalize)", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openDeal(f);
    await deliverAndVerify(f, dealId, VERDICT.Pass);
    await time.increase(DEFAULT_CHALLENGE_WINDOW + 1n);
    await f.escrow.finalize(dealId);
    expect((await verifyReconstruction(f, dealId)).reason).to.equal("verdict_pass");
  });

  it("path: verdict_fail and verdict_inconclusive", async function () {
    for (const [verdict, reason] of [
      [VERDICT.Fail, "verdict_fail"],
      [VERDICT.Inconclusive, "verdict_inconclusive"]
    ] as const) {
      const f = await loadFixture(fixture);
      const dealId = await openDeal(f);
      await deliverAndVerify(f, dealId, verdict);
      await time.increase(DEFAULT_CHALLENGE_WINDOW + 1n);
      await f.escrow.finalize(dealId);
      expect((await verifyReconstruction(f, dealId)).reason).to.equal(reason);
    }
  });

  it("path: ruling_release and ruling_refund, both challenger branches", async function () {
    for (const [verdict, outcome] of [
      [VERDICT.Pass, OUTCOME.Release],
      [VERDICT.Pass, OUTCOME.Refund],
      [VERDICT.Fail, OUTCOME.Release],
      [VERDICT.Fail, OUTCOME.Refund]
    ] as const) {
      const f = await loadFixture(fixture);
      const dealId = await openDeal(f);
      await deliverAndVerify(f, dealId, verdict);
      const challenger = verdict === VERDICT.Pass ? f.buyer : f.seller;
      await f.escrow.connect(challenger).challenge(dealId);
      await f.arbitrator.rule(await f.escrow.getAddress(), dealId, outcome);
      const replay = await verifyReconstruction(f, dealId);
      expect(replay.reason).to.equal(
        outcome === OUTCOME.Release ? "ruling_release" : "ruling_refund"
      );
      if (outcome === OUTCOME.Refund) {
        expect(replay.slashed).to.equal(BOND);
      }
    }
  });

  it("path: ruling_lapsed, both challenger branches", async function () {
    for (const verdict of [VERDICT.Pass, VERDICT.Fail] as const) {
      const f = await loadFixture(fixture);
      const dealId = await openDeal(f);
      await deliverAndVerify(f, dealId, verdict);
      const challenger = verdict === VERDICT.Pass ? f.buyer : f.seller;
      await f.escrow.connect(challenger).challenge(dealId);
      await time.increase(DEFAULT_RULING_WINDOW + 1n);
      await f.escrow.finalize(dealId);
      const replay = await verifyReconstruction(f, dealId);
      expect(replay.reason).to.equal("ruling_lapsed");
      expect(replay.slashed).to.equal(0n);
    }
  });

  it("path: timeout, bonded and unbonded", async function () {
    for (const withBond of [true, false]) {
      const f = await loadFixture(fixture);
      const dealId = await openDeal(f, withBond);
      await time.increase(DURATION + 1n);
      await f.escrow.claimTimeout(dealId);
      expect((await verifyReconstruction(f, dealId)).reason).to.equal("timeout");
    }
  });

  it("path: cancelled, undisputed and mid-dispute", async function () {
    {
      const f = await loadFixture(fixture);
      const dealId = await openDeal(f);
      const { offer, signature } = await signCancellation(f, f.seller, dealId);
      await f.escrow.connect(f.buyer).cancelMutually(offer, signature);
      expect((await verifyReconstruction(f, dealId)).reason).to.equal("cancelled");
    }
    {
      const f = await loadFixture(fixture);
      const dealId = await openDeal(f);
      await deliverAndVerify(f, dealId, VERDICT.Pass);
      await f.escrow.connect(f.buyer).challenge(dealId);
      const { offer, signature } = await signCancellation(f, f.seller, dealId);
      await f.escrow.connect(f.buyer).cancelMutually(offer, signature);
      expect((await verifyReconstruction(f, dealId)).reason).to.equal("cancelled");
    }
  });
});

/**
 * Enforced mechanically. The suite above proves a deal is reconstructable
 * once you have its id; this proves the supervisor can FIND it in the first place,
 * using log topics alone. The distinction is load-bearing: filtering is only possible
 * on `indexed` fields, an event may carry at most three, and the choice is permanent
 * once the immutable contract is deployed.
 *
 * These tests assert the capability (a filtered query returns exactly the right deals
 * and no others), not merely that an event fired - a test that only checked the emit
 * would pass just as happily with the fields unindexed, which is the whole failure
 * mode this suite exists to prevent.
 */
describe("SinettiEscrowV04 events-only queryability", function () {
  const NO_BOND = 0n;

  /** Open one deal against a chosen verifier and arbitrator, and return its id. */
  async function openAgainst(
    f: Fixture,
    verifier: string,
    arbitrator: string
  ): Promise<bigint> {
    await openDealWithSellerAcceptanceV04(
      f.escrow,
      f.buyer,
      f.seller,
      await f.seller.getAddress(),
      verifier,
      arbitrator,
      f.mockUSDC,
      AMOUNT,
      NO_BOND,
      CHALLENGER_BOND,
      TERMS_HASH,
      DURATION
    );
    return (await f.escrow.nextDealId()) - 1n;
  }

  /** The supervisor's primitive: one filtered getLogs, reduced to deal ids. */
  async function dealIdsMatching(escrow: Contract, filter: unknown): Promise<bigint[]> {
    const logs = await escrow.queryFilter(filter as never, 0, "latest");
    return logs
      .filter((log): log is EventLog => log instanceof EventLog)
      .map((log) => log.args.dealId as bigint)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  it("DealParties carries the deal's real verifier and arbitrator", async function () {
    const f = await loadFixture(fixture);
    const verifier = await f.verifier.getAddress();
    const arbitrator = await f.arbitrator.getAddress();
    const dealId = await openAgainst(f, verifier, arbitrator);

    const [event] = await f.escrow.queryFilter(f.escrow.filters.DealParties(dealId));
    const args = (event as EventLog).args;
    // Against the stored deal, not against the values we passed in: an event echoing
    // its own input would prove nothing about what the contract actually recorded.
    const deal = await f.escrow.getDeal(dealId);
    expect(args.verifier).to.equal(deal.verifier);
    expect(args.arbitrator).to.equal(deal.arbitrator);
  });

  it("VerificationRecorded names the deal's assigned verifier", async function () {
    const f = await loadFixture(fixture);
    const dealId = await openAgainst(
      f,
      await f.verifier.getAddress(),
      await f.arbitrator.getAddress()
    );
    await f.escrow.connect(f.seller).submitDelivery(dealId, EVIDENCE_HASH);
    await f.escrow.connect(f.verifier).recordVerification(dealId, VERDICT.Pass);

    const [event] = await f.escrow.queryFilter(
      f.escrow.filters.VerificationRecorded(dealId)
    );
    const deal = await f.escrow.getDeal(dealId);
    expect((event as EventLog).args.verifier).to.equal(deal.verifier);
  });

  it("filters deals by verifier and by arbitrator, excluding every other party's", async function () {
    const f = await loadFixture(fixture);
    const arbitratorFactory = await ethers.getContractFactory("MockManualArbitrator");
    const arbitratorB = (await arbitratorFactory.deploy()) as Contract;
    await arbitratorB.waitForDeployment();

    const verifierA = await f.verifier.getAddress();
    const verifierB = await f.other.getAddress();
    const arbA = await f.arbitrator.getAddress();
    const arbB = await arbitratorB.getAddress();

    const a1 = await openAgainst(f, verifierA, arbA);
    const b1 = await openAgainst(f, verifierB, arbA);
    const a2 = await openAgainst(f, verifierA, arbB);

    expect(
      await dealIdsMatching(f.escrow, f.escrow.filters.DealParties(null, verifierA)),
      "verifier A's deals"
    ).to.deep.equal([a1, a2]);
    expect(
      await dealIdsMatching(f.escrow, f.escrow.filters.DealParties(null, verifierB)),
      "verifier B's deals"
    ).to.deep.equal([b1]);
    expect(
      await dealIdsMatching(
        f.escrow,
        f.escrow.filters.DealParties(null, null, arbB)
      ),
      "arbitrator B's deals"
    ).to.deep.equal([a2]);
    // A verifier with no deals returns nothing rather than everything: a filter that
    // silently degrades to "match all" would be worse than no filter at all.
    expect(
      await dealIdsMatching(
        f.escrow,
        f.escrow.filters.DealParties(null, await f.owner.getAddress())
      ),
      "an unrelated address"
    ).to.deep.equal([]);
  });

  it("derives a verifier's no-show rate from assigned minus recorded, topics only", async function () {
    const f = await loadFixture(fixture);
    const verifierA = await f.verifier.getAddress();
    const verifierB = await f.other.getAddress();
    const arbitrator = await f.arbitrator.getAddress();

    const shown1 = await openAgainst(f, verifierA, arbitrator);
    const shown2 = await openAgainst(f, verifierA, arbitrator);
    const noShow = await openAgainst(f, verifierA, arbitrator);
    const othersDeal = await openAgainst(f, verifierB, arbitrator);

    for (const dealId of [shown1, shown2]) {
      await f.escrow.connect(f.seller).submitDelivery(dealId, EVIDENCE_HASH);
      await f.escrow.connect(f.verifier).recordVerification(dealId, VERDICT.Pass);
    }
    // The third deal is delivered but never verified: verifier A simply never shows up,
    // and the deal exits through the deadline instead. This is the behaviour the escrow
    // does not punish but must make visible.
    await f.escrow.connect(f.seller).submitDelivery(noShow, EVIDENCE_HASH);
    await time.increase(DURATION + 1n);
    await f.escrow.claimTimeout(noShow);

    const assigned = await dealIdsMatching(
      f.escrow,
      f.escrow.filters.DealParties(null, verifierA)
    );
    const recorded = await dealIdsMatching(
      f.escrow,
      f.escrow.filters.VerificationRecorded(null, verifierA)
    );
    expect(assigned, "assigned").to.deep.equal([shown1, shown2, noShow]);
    expect(recorded, "recorded").to.deep.equal([shown1, shown2]);

    const missed = assigned.filter((dealId) => !recorded.includes(dealId));
    expect(missed, "no-show deals").to.deep.equal([noShow]);
    // Verifier B's single deal never leaks into A's figures.
    expect(assigned).to.not.include(othersDeal);
  });

  it("filters settlements by reason across the whole contract", async function () {
    const f = await loadFixture(fixture);
    const verifier = await f.verifier.getAddress();
    const arbitrator = await f.arbitrator.getAddress();

    const accepted = await openAgainst(f, verifier, arbitrator);
    const failed = await openAgainst(f, verifier, arbitrator);
    const timedOut = await openAgainst(f, verifier, arbitrator);

    await f.escrow.connect(f.seller).submitDelivery(accepted, EVIDENCE_HASH);
    await f.escrow.connect(f.verifier).recordVerification(accepted, VERDICT.Pass);
    await f.escrow.connect(f.buyer).accept(accepted);

    await f.escrow.connect(f.seller).submitDelivery(failed, EVIDENCE_HASH);
    await f.escrow.connect(f.verifier).recordVerification(failed, VERDICT.Fail);
    await time.increase(DEFAULT_CHALLENGE_WINDOW + 1n);
    await f.escrow.finalize(failed);

    await time.increase(DURATION + 1n);
    await f.escrow.claimTimeout(timedOut);

    // reason is a bytes32, a value type, so the topic holds the readable string rather
    // than a hash of it - the filter argument is the same encoding the contract stores.
    for (const [reason, expected] of [
      ["accepted", accepted],
      ["verdict_fail", failed],
      ["timeout", timedOut]
    ] as const) {
      expect(
        await dealIdsMatching(
          f.escrow,
          f.escrow.filters.Settled(null, ethers.encodeBytes32String(reason))
        ),
        `settled by reason ${reason}`
      ).to.deep.equal([expected]);
    }
    // A reason no deal reached matches nothing.
    expect(
      await dealIdsMatching(
        f.escrow,
        f.escrow.filters.Settled(null, ethers.encodeBytes32String("ruling_refund"))
      ),
      "a reason no deal reached"
    ).to.deep.equal([]);
  });
});
