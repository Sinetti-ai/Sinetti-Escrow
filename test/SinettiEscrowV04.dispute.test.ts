import { expect } from "chai";
import { Contract, Signer } from "ethers";
import { ethers } from "./helpers/hardhat";
import { loadFixture, time } from "./helpers/hardhat";
import {
  openDealWithSellerAcceptanceV04,
  DEFAULT_CHALLENGE_WINDOW,
  DEFAULT_RULING_WINDOW
} from "./helpers/sellerAcceptanceV04";

const TERMS_HASH = ethers.encodeBytes32String("criteria+mandate");
const EVIDENCE_HASH = ethers.encodeBytes32String("evidence of delivery");

const REASON = {
  rulingRelease: ethers.encodeBytes32String("ruling_release"),
  rulingRefund: ethers.encodeBytes32String("ruling_refund"),
  rulingLapsed: ethers.encodeBytes32String("ruling_lapsed"),
  cancelled: ethers.encodeBytes32String("cancelled")
};

const VERDICT = { Pass: 1n, Fail: 2n, Inconclusive: 3n };
const OUTCOME = { None: 0n, Release: 1n, Refund: 2n };
const STATE = { Verified: 3n, Disputed: 4n, Released: 5n, Refunded: 6n, Cancelled: 7n };

const AMOUNT = 100_000n;
const BOND = 25_000n;
const CHALLENGER_BOND = 10_000n;
const DURATION = 7_200n;

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
    [buyer, AMOUNT * 10n],
    [seller, BOND * 10n]
  ] as const) {
    await mockUSDC.mint(await party.getAddress(), funds);
    await mockUSDC.connect(party).approve(await escrow.getAddress(), funds);
  }

  return { owner, buyer, seller, verifier, other, mockUSDC, arbitrator, escrow };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function openVerifiedDeal(f: Fixture, verdict: bigint): Promise<bigint> {
  await openDealWithSellerAcceptanceV04(
    f.escrow,
    f.buyer,
    f.seller,
    await f.seller.getAddress(),
    await f.verifier.getAddress(),
    await f.arbitrator.getAddress(),
    f.mockUSDC,
    AMOUNT,
    BOND,
    CHALLENGER_BOND,
    TERMS_HASH,
    DURATION
  );
  const dealId = (await f.escrow.nextDealId()) - 1n;
  await f.escrow.connect(f.seller).postBond(dealId);
  await f.escrow.connect(f.seller).submitDelivery(dealId, EVIDENCE_HASH);
  await f.escrow.connect(f.verifier).recordVerification(dealId, verdict);
  return dealId;
}

async function rule(f: Fixture, dealId: bigint, outcome: bigint) {
  return f.arbitrator.rule(await f.escrow.getAddress(), dealId, outcome);
}

async function assertConservationAndDrain(f: Fixture, parties: Signer[]) {
  const tokenAddress = await f.mockUSDC.getAddress();
  let creditSum = 0n;
  for (const party of parties) {
    creditSum += await f.escrow.withdrawable(tokenAddress, await party.getAddress());
  }
  const [liabilities, actualBalance] = await f.escrow.tokenAccounting(tokenAddress);
  expect(liabilities).to.equal(creditSum);
  expect(actualBalance).to.equal(creditSum);
  for (const party of parties) {
    if ((await f.escrow.withdrawable(tokenAddress, await party.getAddress())) > 0n) {
      await f.escrow.connect(party)["withdraw(address)"](tokenAddress);
    }
  }
  expect(await f.mockUSDC.balanceOf(await f.escrow.getAddress())).to.equal(0n);
}

describe("SinettiEscrowV04 dispute", function () {
  describe("challenge", function () {
    it("buyer challenges a Pass: bond pulled, Disputed, ruling deadline set, Challenged emitted", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);

      const tx = await f.escrow.connect(f.buyer).challenge(dealId);
      const challengedAt = BigInt(await time.latest());
      await expect(tx)
        .to.emit(f.escrow, "Challenged")
        .withArgs(
          dealId,
          await f.buyer.getAddress(),
          CHALLENGER_BOND,
          challengedAt + DEFAULT_RULING_WINDOW
        );

      const deal = await f.escrow.getDeal(dealId);
      expect(deal.state).to.equal(STATE.Disputed);
      const dispute = await f.escrow.disputes(dealId);
      expect(dispute.challenger).to.equal(await f.buyer.getAddress());
      expect(dispute.rulingDeadline).to.equal(challengedAt + DEFAULT_RULING_WINDOW);
      expect(await f.escrow.tokenLiability(await f.mockUSDC.getAddress())).to.equal(
        AMOUNT + BOND + CHALLENGER_BOND
      );
    });

    it("only the disadvantaged party may challenge: seller cannot fight a Pass, buyer cannot fight a Fail", async function () {
      const f = await loadFixture(fixture);
      const passDeal = await openVerifiedDeal(f, VERDICT.Pass);
      await expect(
        f.escrow.connect(f.seller).challenge(passDeal)
      ).to.be.revertedWithCustomError(f.escrow, "NotBuyer");
      await expect(
        f.escrow.connect(f.other).challenge(passDeal)
      ).to.be.revertedWithCustomError(f.escrow, "NotBuyer");

      const failDeal = await openVerifiedDeal(f, VERDICT.Fail);
      await expect(
        f.escrow.connect(f.buyer).challenge(failDeal)
      ).to.be.revertedWithCustomError(f.escrow, "NotSeller");
      const inconclusiveDeal = await openVerifiedDeal(f, VERDICT.Inconclusive);
      await expect(f.escrow.connect(f.seller).challenge(inconclusiveDeal)).to.not.be
        .revert(ethers);
    });

    it("closes exactly at challengeEndsAt, and a reverted challenge writes no state", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      const endsAt = await f.escrow.challengeEndsAt(dealId);

      await time.increaseTo(endsAt);
      await expect(
        f.escrow.connect(f.buyer).challenge(dealId)
      ).to.be.revertedWithCustomError(f.escrow, "ChallengeWindowClosed");

      // Nothing was written by the reverted attempt: still Verified, no dispute
      // record, no liability change, revision untouched.
      const deal = await f.escrow.getDeal(dealId);
      expect(deal.state).to.equal(STATE.Verified);
      expect(deal.revision).to.equal(4n);
      const dispute = await f.escrow.disputes(dealId);
      expect(dispute.challenger).to.equal(ethers.ZeroAddress);
      expect(await f.escrow.tokenLiability(await f.mockUSDC.getAddress())).to.equal(
        AMOUNT + BOND
      );
    });

    it("cannot challenge twice, cannot challenge non-Verified states", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      await f.escrow.connect(f.buyer).challenge(dealId);
      await expect(
        f.escrow.connect(f.buyer).challenge(dealId)
      ).to.be.revertedWithCustomError(f.escrow, "DealNotVerified");
    });

    it("fails when the challenger cannot fund the bond, leaving the deal unharmed", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      await f.mockUSDC
        .connect(f.buyer)
        .transfer(await f.other.getAddress(), await f.mockUSDC.balanceOf(f.buyer));
      await expect(f.escrow.connect(f.buyer).challenge(dealId)).to.be.revert(ethers);
      expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Verified);
      // The deal still settles normally afterwards.
      await time.increase(DEFAULT_CHALLENGE_WINDOW + 1n);
      await f.escrow.finalize(dealId);
    });
  });

  describe("submitEvidence", function () {
    it("parties may put evidence on the record only while Disputed", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      await expect(
        f.escrow.connect(f.buyer).submitEvidence(dealId, "ipfs://too-early")
      ).to.be.revertedWithCustomError(f.escrow, "DealNotDisputed");

      await f.escrow.connect(f.buyer).challenge(dealId);
      await expect(f.escrow.connect(f.buyer).submitEvidence(dealId, "ipfs://buyer-proof"))
        .to.emit(f.escrow, "Evidence")
        .withArgs(
          await f.arbitrator.getAddress(),
          dealId,
          await f.buyer.getAddress(),
          "ipfs://buyer-proof"
        );
      await expect(f.escrow.connect(f.seller).submitEvidence(dealId, "ipfs://seller-proof"))
        .to.emit(f.escrow, "Evidence");
      await expect(
        f.escrow.connect(f.other).submitEvidence(dealId, "ipfs://stranger")
      ).to.be.revertedWithCustomError(f.escrow, "NotParty");
    });
  });

  describe("submitRuling", function () {
    it("Release with the buyer as challenger: seller gets A+B+C (loser pays)", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      await f.escrow.connect(f.buyer).challenge(dealId);

      await expect(rule(f, dealId, OUTCOME.Release))
        .to.emit(f.escrow, "RulingSubmitted")
        .withArgs(dealId, await f.arbitrator.getAddress(), OUTCOME.Release)
        .and.to.emit(f.escrow, "Settled")
        .withArgs(dealId, REASON.rulingRelease, AMOUNT + BOND + CHALLENGER_BOND, 0n);

      expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Released);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("Release with the seller as challenger: seller gets A+B plus their own bond back", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Fail);
      await f.escrow.connect(f.seller).challenge(dealId);

      await expect(rule(f, dealId, OUTCOME.Release))
        .to.emit(f.escrow, "Settled")
        .withArgs(dealId, REASON.rulingRelease, AMOUNT + BOND + CHALLENGER_BOND, 0n);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("Refund with the buyer as challenger: the ONLY slash path - buyer gets A+B+C, BondSlashed", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      await f.escrow.connect(f.buyer).challenge(dealId);

      await expect(rule(f, dealId, OUTCOME.Refund))
        .to.emit(f.escrow, "BondSlashed")
        .withArgs(dealId, BOND)
        .and.to.emit(f.escrow, "Settled")
        .withArgs(dealId, REASON.rulingRefund, 0n, AMOUNT + BOND + CHALLENGER_BOND);

      expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Refunded);
      expect(
        await f.escrow.withdrawable(
          await f.mockUSDC.getAddress(),
          await f.seller.getAddress()
        )
      ).to.equal(0n);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("Refund with the seller as challenger: slash plus forfeited challenger bond", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Fail);
      await f.escrow.connect(f.seller).challenge(dealId);

      await expect(rule(f, dealId, OUTCOME.Refund))
        .to.emit(f.escrow, "Settled")
        .withArgs(dealId, REASON.rulingRefund, 0n, AMOUNT + BOND + CHALLENGER_BOND);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("guards: only the named arbitrator, only Disputed, only before the deadline, only Release/Refund", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);

      await expect(
        f.escrow.connect(f.other).submitRuling(dealId, OUTCOME.Release)
      ).to.be.revertedWithCustomError(f.escrow, "DealNotDisputed");

      await f.escrow.connect(f.buyer).challenge(dealId);
      await expect(
        f.escrow.connect(f.other).submitRuling(dealId, OUTCOME.Release)
      ).to.be.revertedWithCustomError(f.escrow, "NotArbitrator");
      await expect(rule(f, dealId, 0n)).to.be.revertedWithCustomError(
        f.escrow,
        "InvalidOutcome"
      );
      await expect(rule(f, dealId, 3n)).to.be.revertedWithCustomError(
        f.escrow,
        "InvalidOutcome"
      );

      await time.increase(DEFAULT_RULING_WINDOW + 1n);
      await expect(rule(f, dealId, OUTCOME.Release)).to.be.revertedWithCustomError(
        f.escrow,
        "RulingDeadlinePassed"
      );
    });

    it("cannot rule twice, cannot rule an undisputed or foreign deal", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      await f.escrow.connect(f.buyer).challenge(dealId);
      await rule(f, dealId, OUTCOME.Release);
      await expect(rule(f, dealId, OUTCOME.Refund)).to.be.revertedWithCustomError(
        f.escrow,
        "DealNotDisputed"
      );
      await expect(rule(f, dealId + 1n, OUTCOME.Release)).to.be.revertedWithCustomError(
        f.escrow,
        "DealNotDisputed"
      );
    });
  });

  describe("finalize on arbitrator silence (lapse)", function () {
    it("standing Pass executes and the buyer-challenger gets the bond back", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      await f.escrow.connect(f.buyer).challenge(dealId);

      await expect(f.escrow.finalize(dealId)).to.be.revertedWithCustomError(
        f.escrow,
        "FinalizationNotReady"
      );
      await time.increase(DEFAULT_RULING_WINDOW + 1n);
      await expect(f.escrow.connect(f.other).finalize(dealId))
        .to.emit(f.escrow, "Settled")
        .withArgs(dealId, REASON.rulingLapsed, AMOUNT + BOND, CHALLENGER_BOND);
      expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Released);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("standing Fail executes and the seller-challenger gets the bond back - no slash on silence", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Fail);
      await f.escrow.connect(f.seller).challenge(dealId);

      await time.increase(DEFAULT_RULING_WINDOW + 1n);
      const tx = await f.escrow.finalize(dealId);
      await expect(tx)
        .to.emit(f.escrow, "Settled")
        .withArgs(dealId, REASON.rulingLapsed, BOND + CHALLENGER_BOND, AMOUNT);
      await expect(tx).to.not.emit(f.escrow, "BondSlashed");
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("the ruling and lapse boundaries are mutually exclusive at the deadline instant", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      await f.escrow.connect(f.buyer).challenge(dealId);
      const dispute = await f.escrow.disputes(dealId);

      // One second before the deadline: finalize is not ready.
      await time.setNextBlockTimestamp(dispute.rulingDeadline - 1n);
      await expect(f.escrow.finalize(dealId)).to.be.revertedWithCustomError(
        f.escrow,
        "FinalizationNotReady"
      );
      // At the deadline instant: the ruling is closed and finalize is open - the
      // ts < deadline / ts >= deadline pair is exclusive within any single block.
      await time.setNextBlockTimestamp(dispute.rulingDeadline);
      await expect(rule(f, dealId, OUTCOME.Release)).to.be.revertedWithCustomError(
        f.escrow,
        "RulingDeadlinePassed"
      );
      await time.setNextBlockTimestamp(dispute.rulingDeadline + 1n);
      await f.escrow.finalize(dealId);
    });
  });

  describe("cancel during dispute", function () {
    async function signOffer(f: Fixture, signer: Signer, dealId: bigint, revision: bigint) {
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

    it("unwinds exactly: the buyer-challenger recovers the challenger bond", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      await f.escrow.connect(f.buyer).challenge(dealId);

      const revision = (await f.escrow.getDeal(dealId)).revision;
      const { offer, signature } = await signOffer(f, f.seller, dealId, revision);
      await expect(f.escrow.connect(f.buyer).cancelMutually(offer, signature))
        .to.emit(f.escrow, "Settled")
        .withArgs(dealId, REASON.cancelled, BOND, AMOUNT + CHALLENGER_BOND);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("the seller-challenger recovers theirs, and a late ruling then reverts", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Fail);
      await f.escrow.connect(f.seller).challenge(dealId);

      const revision = (await f.escrow.getDeal(dealId)).revision;
      const { offer, signature } = await signOffer(f, f.buyer, dealId, revision);
      await expect(f.escrow.connect(f.seller).cancelMutually(offer, signature))
        .to.emit(f.escrow, "Settled")
        .withArgs(dealId, REASON.cancelled, BOND + CHALLENGER_BOND, AMOUNT);

      // Arbitration became moot: the terminal-state guard rejects the ruling.
      await expect(rule(f, dealId, OUTCOME.Refund)).to.be.revertedWithCustomError(
        f.escrow,
        "DealNotDisputed"
      );
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });
  });

  describe("reentrancy", function () {
    it("a token that reenters during the challenger-bond pull is stopped by the guard", async function () {
      const f = await loadFixture(fixture);
      const maliciousFactory = await ethers.getContractFactory("MaliciousReentrantToken");
      const malicious = (await maliciousFactory.connect(f.owner).deploy()) as Contract;
      await malicious.waitForDeployment();

      const escrowFactory = await ethers.getContractFactory("SinettiEscrowV04");
      const escrow = (await escrowFactory.connect(f.owner).deploy(
        await f.owner.getAddress(),
        [
          {
            token: await malicious.getAddress(),
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
        [f.buyer, AMOUNT * 4n],
        [f.seller, BOND * 4n]
      ] as const) {
        await malicious.mint(await party.getAddress(), funds);
        await malicious.connect(party).approve(await escrow.getAddress(), funds);
      }

      await openDealWithSellerAcceptanceV04(
        escrow, f.buyer, f.seller,
        await f.seller.getAddress(), await f.verifier.getAddress(),
        await f.arbitrator.getAddress(), malicious,
        AMOUNT, BOND, CHALLENGER_BOND, TERMS_HASH, DURATION
      );
      await escrow.connect(f.seller).postBond(1n);
      await escrow.connect(f.seller).submitDelivery(1n, EVIDENCE_HASH);
      await escrow.connect(f.verifier).recordVerification(1n, VERDICT.Pass);

      // Arm the token to reenter challenge() from inside the bond pull. The
      // nonReentrant guard must kill the whole transaction.
      await malicious.arm(
        await escrow.getAddress(),
        escrow.interface.encodeFunctionData("challenge", [1n]),
        true,
        true
      );
      await expect(escrow.connect(f.buyer).challenge(1n)).to.be.revert(ethers);

      // Disarmed, the same challenge lands cleanly.
      await malicious.disarm();
      await expect(escrow.connect(f.buyer).challenge(1n)).to.not.be.revert(ethers);
    });
  });

  describe("dispute path while paused", function () {
    it("challenge, evidence, ruling, and lapse-finalize all run while paused", async function () {
      const f = await loadFixture(fixture);
      const dealId = await openVerifiedDeal(f, VERDICT.Pass);
      await f.escrow.connect(f.owner).pause();

      await f.escrow.connect(f.buyer).challenge(dealId);
      await f.escrow.connect(f.buyer).submitEvidence(dealId, "ipfs://while-paused");
      await rule(f, dealId, OUTCOME.Release);
      expect((await f.escrow.getDeal(dealId)).state).to.equal(STATE.Released);
    });
  });
});
