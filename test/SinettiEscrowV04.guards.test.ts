import { expect } from "chai";
import { Contract, Signer } from "ethers";
import { ethers } from "./helpers/hardhat";
import { time } from "./helpers/hardhat";

import {
  openDealWithSellerAcceptanceV04,
  DEFAULT_CHALLENGE_WINDOW
} from "./helpers/sellerAcceptanceV04";

/**
 * Guards the rest of the suite reaches only by accident.
 *
 * Three families, each of which the happy-path suites walk straight past:
 *   1. the non-1:1 token defenses - every `_pull`/`_withdraw` exact-delta assertion;
 *   2. the participant and arbitrator allowlists, which a restricted deployment
 *      enables and every other fixture leaves off;
 *   3. the token-policy caps and the bond floor, including the ceiling-rounded edge.
 * Plus the exact-instant clock boundaries that `time.increase` cannot prove.
 */

const TERMS_HASH = ethers.encodeBytes32String("criteria+mandate");
const EVIDENCE_HASH = ethers.encodeBytes32String("evidence of delivery");

const VERDICT = { Pass: 1n, Fail: 2n };

const AMOUNT = 100_000n;
const BOND = 25_000n;
const CHALLENGER_BOND = 10_000n;
const DURATION = 7_200n;

type TokenKind = "clean" | "fee" | "mutable";

type Policy = {
  maxAmount?: bigint;
  maxBond?: bigint;
  minBondBps?: bigint;
  minChallengerBondBps?: bigint;
};

/**
 * One escrow, one token, and the allowlists either off (the default everywhere
 * else in the suite) or on with an explicit membership.
 */
async function build(options: {
  token?: TokenKind;
  policy?: Policy;
  restrict?: boolean;
  restrictArbitratorOnly?: boolean;
  omitFromAllowlist?: "buyer" | "seller" | "verifier" | "arbitrator";
} = {}) {
  const [owner, buyer, seller, verifier, other] = await ethers.getSigners();

  const factoryName = {
    clean: "MockUSDC",
    fee: "MockFeeToken",
    mutable: "MutableFeeToken"
  }[options.token ?? "clean"];
  const tokenFactory = await ethers.getContractFactory(factoryName);
  const token = (await (options.token === "fee"
    ? tokenFactory.connect(owner).deploy(100n) // 1% fee on every transfer
    : tokenFactory.connect(owner).deploy())) as Contract;
  await token.waitForDeployment();

  const arbitratorFactory = await ethers.getContractFactory("MockManualArbitrator");
  const arbitrator = (await arbitratorFactory.connect(owner).deploy()) as Contract;
  await arbitrator.waitForDeployment();

  const addresses = {
    buyer: await buyer.getAddress(),
    seller: await seller.getAddress(),
    verifier: await verifier.getAddress(),
    arbitrator: await arbitrator.getAddress()
  };

  const participants = options.restrict
    ? (["buyer", "seller", "verifier"] as const)
      .filter((role) => role !== options.omitFromAllowlist)
      .map((role) => addresses[role])
    : [];
  // A restricted deployment must name at least three participants; when the test
  // omits one, a stranger keeps the cardinality legal so the constructor's
  // InsufficientParticipants guard cannot mask the ParticipantNotListed one.
  if (options.restrict && participants.length < 3) {
    participants.push(await other.getAddress());
  }
  const restrictArbitrator = options.restrict || options.restrictArbitratorOnly;
  const arbitrators = restrictArbitrator && options.omitFromAllowlist !== "arbitrator"
    ? [addresses.arbitrator]
    : restrictArbitrator
      ? [await (await arbitratorFactory.connect(owner).deploy()).getAddress()]
      : [];

  const escrowFactory = await ethers.getContractFactory("SinettiEscrowV04");
  const escrow = (await escrowFactory.connect(owner).deploy(
    await owner.getAddress(),
    [{
      token: await token.getAddress(),
      maxAmount: options.policy?.maxAmount ?? ethers.MaxUint256,
      maxBond: options.policy?.maxBond ?? ethers.MaxUint256,
      minBondBps: options.policy?.minBondBps ?? 0n,
      minChallengerBondBps: options.policy?.minChallengerBondBps ?? 0n
    }],
    participants,
    arbitrators
  , 60, 60)) as Contract;
  await escrow.waitForDeployment();

  const escrowAddress = await escrow.getAddress();
  for (const [party, funding] of [
    [buyer, AMOUNT * 10n],
    [seller, BOND * 10n],
    [other, AMOUNT * 10n]
  ] as const) {
    await token.mint(await party.getAddress(), funding);
    await token.connect(party).approve(escrowAddress, ethers.MaxUint256);
  }

  return { owner, buyer, seller, verifier, other, token, arbitrator, escrow, addresses };
}

type World = Awaited<ReturnType<typeof build>>;

async function open(
  world: World,
  overrides: { amount?: bigint; bond?: bigint; termsHash?: string } = {}
) {
  return openDealWithSellerAcceptanceV04(
    world.escrow,
    world.buyer,
    world.seller,
    world.addresses.seller,
    world.addresses.verifier,
    world.addresses.arbitrator,
    world.token,
    overrides.amount ?? AMOUNT,
    overrides.bond ?? BOND,
    CHALLENGER_BOND,
    overrides.termsHash ?? TERMS_HASH,
    DURATION
  );
}

/// Open, bond, deliver, and record a verdict, leaving the deal Verified.
async function toVerified(world: World, verdict: bigint = VERDICT.Pass): Promise<bigint> {
  const dealId = (await world.escrow.nextDealId()) as bigint;
  await open(world);
  await world.escrow.connect(world.seller).postBond(dealId);
  await world.escrow.connect(world.seller).submitDelivery(dealId, EVIDENCE_HASH);
  await world.escrow.connect(world.verifier).recordVerification(dealId, verdict);
  return dealId;
}

describe("SinettiEscrowV04 guards", () => {
  describe("non-1:1 tokens: every exact-delta assertion fires", () => {
    it("refuses to open a deal in a fee-on-transfer token (AmountMismatch)", async () => {
      const world = await build({ token: "fee" });

      await expect(open(world)).to.be.revertedWithCustomError(world.escrow, "AmountMismatch");
      // Nothing was banked: a rejected open leaves no dust behind.
      expect(await world.token.balanceOf(await world.escrow.getAddress())).to.equal(0n);
    });

    it("refuses a bond in a token that turns fee-charging after the deal opened (BondMismatch)", async () => {
      const world = await build({ token: "mutable" });
      const dealId = (await world.escrow.nextDealId()) as bigint;
      await open(world);

      await world.token.setFees(0n, 100n);

      await expect(world.escrow.connect(world.seller).postBond(dealId))
        .to.be.revertedWithCustomError(world.escrow, "BondMismatch");
    });

    it("refuses a challenger bond that arrives short (ChallengerBondMismatch)", async () => {
      const world = await build({ token: "mutable" });
      const dealId = await toVerified(world, VERDICT.Fail);

      await world.token.setFees(0n, 100n);

      await expect(world.escrow.connect(world.seller).challenge(dealId))
        .to.be.revertedWithCustomError(world.escrow, "ChallengerBondMismatch");
    });

    it("refuses a withdrawal that would not land whole (WithdrawalAmountMismatch)", async () => {
      const world = await build({ token: "mutable" });
      const dealId = await toVerified(world);
      await world.escrow.connect(world.buyer).accept(dealId);
      const tokenAddress = await world.token.getAddress();
      expect(await world.escrow.withdrawable(tokenAddress, world.addresses.seller))
        .to.equal(AMOUNT + BOND);

      await world.token.setFees(0n, 100n);

      await expect(world.escrow.connect(world.seller)["withdraw(address)"](tokenAddress))
        .to.be.revertedWithCustomError(world.escrow, "WithdrawalAmountMismatch");
      // The credit survives the failed attempt; the money is stuck, never lost.
      expect(await world.escrow.withdrawable(tokenAddress, world.addresses.seller))
        .to.equal(AMOUNT + BOND);
    });

    it("reverts the sender-side fee case too, where the escrow over-pays", async () => {
      const world = await build({ token: "mutable" });
      const dealId = await toVerified(world);
      await world.escrow.connect(world.buyer).accept(dealId);
      // A second live deal leaves the escrow holding someone else's principal,
      // which is precisely what a sender fee would raid on the way out.
      await open(world);

      // A sender fee leaves the recipient whole but drains the escrow by more
      // than `amount`, which the escrow-side half of the assertion catches.
      await world.token.setFees(100n, 0n);

      await expect(
        world.escrow.connect(world.seller)["withdraw(address)"](await world.token.getAddress())
      ).to.be.revertedWithCustomError(world.escrow, "WithdrawalAmountMismatch");
    });
  });

  describe("the commitment a deal opens on", () => {
    it("refuses a deal whose terms commit to nothing (ZeroTermsHash)", async () => {
      const world = await build();
      await expect(
        open(world, { termsHash: ethers.ZeroHash })
      ).to.be.revertedWithCustomError(world.escrow, "ZeroTermsHash");
    });

    // The asymmetry this closes: submitDelivery has always rejected a zero
    // evidenceHash, while openDeal accepted a zero termsHash, so the contract
    // refused a delivery that committed to nothing but funded a deal that did.
    // Both hashes are seller-signed, so consent never distinguished them.
    it("refuses a zero evidence hash on the same deal, as it always has", async () => {
      const world = await build();
      const dealId = (await world.escrow.nextDealId()) as bigint;
      await open(world);
      await world.escrow.connect(world.seller).postBond(dealId);
      await expect(
        world.escrow.connect(world.seller).submitDelivery(dealId, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(world.escrow, "ZeroEvidence");
    });
  });

  describe("optional deployment allowlists", () => {
    it("opens normally when every party and the arbitrator are listed", async () => {
      const world = await build({ restrict: true });
      const dealId = (await world.escrow.nextDealId()) as bigint;

      await expect(open(world)).to.emit(world.escrow, "DealOpened");
      expect((await world.escrow.getDeal(dealId)).state).to.equal(1n);
    });

    for (const role of ["buyer", "seller", "verifier"] as const) {
      it(`rejects an unlisted ${role} (ParticipantNotListed)`, async () => {
        const world = await build({ restrict: true, omitFromAllowlist: role });

        await expect(open(world))
          .to.be.revertedWithCustomError(world.escrow, "ParticipantNotListed")
          .withArgs(world.addresses[role]);
      });
    }

    it("rejects an arbitrator contract that was never attested (ArbitratorNotListed)", async () => {
      const world = await build({ restrict: true, omitFromAllowlist: "arbitrator" });

      await expect(open(world))
        .to.be.revertedWithCustomError(world.escrow, "ArbitratorNotListed")
        .withArgs(world.addresses.arbitrator);
    });

    it("leaves both allowlists inert when the constructor got empty lists", async () => {
      const world = await build();

      expect(await world.escrow.participantAllowlistEnabled()).to.equal(false);
      expect(await world.escrow.arbitratorAllowlistEnabled()).to.equal(false);
      expect(await world.escrow.listedArbitrator(world.addresses.arbitrator)).to.equal(false);
      // Unlisted and still openable: with open enrollment the only arbitrator
      // requirement is that the address has code.
      await expect(open(world)).to.emit(world.escrow, "DealOpened");
    });

    it("can restrict arbitrators while leaving participant enrollment open", async () => {
      const listed = await build({ restrictArbitratorOnly: true });
      expect(await listed.escrow.participantAllowlistEnabled()).to.equal(false);
      expect(await listed.escrow.arbitratorAllowlistEnabled()).to.equal(true);
      await expect(open(listed)).to.emit(listed.escrow, "DealOpened");

      const unlisted = await build({
        restrictArbitratorOnly: true,
        omitFromAllowlist: "arbitrator"
      });
      await expect(open(unlisted))
        .to.be.revertedWithCustomError(unlisted.escrow, "ArbitratorNotListed")
        .withArgs(unlisted.addresses.arbitrator);
    });

    it("rejects a duplicated or zero participant at construction", async () => {
      const [owner] = await ethers.getSigners();
      const escrowFactory = await ethers.getContractFactory("SinettiEscrowV04");
      const token = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await token.waitForDeployment();
      const arbitrator = await (await ethers.getContractFactory("MockManualArbitrator")).deploy();
      await arbitrator.waitForDeployment();
      const policy = [{
        token: await token.getAddress(),
        maxAmount: ethers.MaxUint256,
        maxBond: ethers.MaxUint256,
        minBondBps: 0n,
        minChallengerBondBps: 0n
      }];
      const deployer = await owner.getAddress();
      const arbitrators = [await arbitrator.getAddress()];

      await expect(escrowFactory.deploy(
        deployer,
        policy,
        [deployer, deployer, deployer],
        arbitrators
      , 60, 60)).to.be.revertedWithCustomError(escrowFactory, "DuplicateParticipant");

      await expect(escrowFactory.deploy(
        deployer,
        policy,
        [deployer, ethers.ZeroAddress, arbitrators[0]],
        arbitrators
      , 60, 60)).to.be.revertedWithCustomError(escrowFactory, "ZeroParticipant");
    });
  });

  describe("token policy: the listing, the caps, and the bond floor", () => {
    it("rejects a token the deployment never listed (TokenNotListed)", async () => {
      const world = await build();
      const stranger = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await stranger.waitForDeployment();
      await stranger.mint(world.addresses.buyer, AMOUNT);
      await stranger.connect(world.buyer).approve(await world.escrow.getAddress(), AMOUNT);

      await expect(openDealWithSellerAcceptanceV04(
        world.escrow,
        world.buyer,
        world.seller,
        world.addresses.seller,
        world.addresses.verifier,
        world.addresses.arbitrator,
        stranger,
        AMOUNT,
        0n,
        CHALLENGER_BOND,
        TERMS_HASH,
        DURATION
      )).to.be.revertedWithCustomError(world.escrow, "TokenNotListed");
    });

    it("holds the amount cap exactly at its edge (AmountExceedsCap)", async () => {
      const world = await build({ policy: { maxAmount: AMOUNT } });

      await expect(open(world, { amount: AMOUNT + 1n }))
        .to.be.revertedWithCustomError(world.escrow, "AmountExceedsCap");
      await expect(open(world, { amount: AMOUNT })).to.emit(world.escrow, "DealOpened");
    });

    it("holds the bond cap exactly at its edge (BondExceedsCap)", async () => {
      const world = await build({ policy: { maxBond: BOND } });

      await expect(open(world, { bond: BOND + 1n }))
        .to.be.revertedWithCustomError(world.escrow, "BondExceedsCap");
      await expect(open(world, { bond: BOND })).to.emit(world.escrow, "DealOpened");
    });

    it("enforces the minimum bond with the same ceiling rounding the constructor checks", async () => {
      // 1000 bps of 100_000 is exactly 10_000, so the boundary is unambiguous.
      const world = await build({ policy: { minBondBps: 1_000n } });
      const floor = (AMOUNT * 1_000n) / 10_000n;

      await expect(open(world, { bond: floor - 1n }))
        .to.be.revertedWithCustomError(world.escrow, "BondBelowMinimum");
      await expect(open(world, { bond: floor })).to.emit(world.escrow, "DealOpened");
    });

    it("rounds the bond floor up, never down, on an inexact amount", async () => {
      const world = await build({ policy: { minBondBps: 1n } });
      // 1 bp of 10_001 is 1.0001 units; rounding down would let a 1-unit bond
      // through, so the floor must be 2.
      const amount = 10_001n;

      await expect(open(world, { amount, bond: 1n }))
        .to.be.revertedWithCustomError(world.escrow, "BondBelowMinimum");
      await expect(open(world, { amount, bond: 2n })).to.emit(world.escrow, "DealOpened");
    });
  });

  describe("clock boundaries proven at the exact instant", () => {
    it("refuses a timeout refund one second early and allows it exactly on the deadline", async () => {
      const world = await build();
      const dealId = (await world.escrow.nextDealId()) as bigint;
      await open(world);
      const deadline = (await world.escrow.getDeal(dealId)).deadline as bigint;

      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(world.escrow.connect(world.buyer).claimTimeout(dealId))
        .to.be.revertedWithCustomError(world.escrow, "DeadlineNotReached");

      await time.setNextBlockTimestamp(deadline);
      await expect(world.escrow.connect(world.buyer).claimTimeout(dealId))
        .to.emit(world.escrow, "Settled");
    });

    it("closes the challenge window and opens finalization at the same instant", async () => {
      const world = await build();
      const dealId = await toVerified(world);
      const endsAt = (await world.escrow.challengeEndsAt(dealId)) as bigint;
      expect(endsAt).to.be.greaterThan(0n);

      await time.setNextBlockTimestamp(endsAt - 1n);
      await expect(world.escrow.connect(world.other).finalize(dealId))
        .to.be.revertedWithCustomError(world.escrow, "FinalizationNotReady");

      // One instant later the window is closed to challenges and open to anyone.
      await time.setNextBlockTimestamp(endsAt);
      await expect(world.escrow.connect(world.buyer).challenge(dealId))
        .to.be.revertedWithCustomError(world.escrow, "ChallengeWindowClosed");
      await expect(world.escrow.connect(world.other).finalize(dealId))
        .to.emit(world.escrow, "Settled");
    });

    it("reports no elapsed window while no verdict exists", async () => {
      const world = await build();
      const dealId = (await world.escrow.nextDealId()) as bigint;
      await open(world);

      expect(await world.escrow.challengeEndsAt(dealId)).to.equal(0n);
      // Far past any window length, an absent verdict is still not an expired right.
      await time.increase(DEFAULT_CHALLENGE_WINDOW * 10n);
      await expect(world.escrow.connect(world.other).finalize(dealId))
        .to.be.revertedWithCustomError(world.escrow, "FinalizationNotReady");
    });
  });
});
