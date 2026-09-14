import { expect } from "chai";
import { Contract, Signer } from "ethers";
import { ethers } from "./helpers/hardhat";
import { loadFixture, time } from "./helpers/hardhat";
import {
  openDealWithSellerAcceptanceV04,
  sellerAcceptanceV04,
  DEFAULT_CHALLENGE_WINDOW,
  DEFAULT_RULING_WINDOW
} from "./helpers/sellerAcceptanceV04";

const TERMS_HASH = ethers.encodeBytes32String("criteria+mandate");
const EVIDENCE_HASH = ethers.encodeBytes32String("evidence of delivery");
const BUYER_ID_REF = ethers.encodeBytes32String("buyer vLEI record");
const SELLER_ID_REF = ethers.encodeBytes32String("seller vLEI record");
const VERIFIER_ID_REF = ethers.encodeBytes32String("verifier vLEI record");
const ARBITRATOR_ID_REF = ethers.encodeBytes32String("arbitrator vLEI record");

const REASON = {
  accepted: ethers.encodeBytes32String("accepted"),
  verdictPass: ethers.encodeBytes32String("verdict_pass"),
  verdictFail: ethers.encodeBytes32String("verdict_fail"),
  verdictInconclusive: ethers.encodeBytes32String("verdict_inconclusive"),
  timeout: ethers.encodeBytes32String("timeout"),
  cancelled: ethers.encodeBytes32String("cancelled")
};

const VERDICT = { None: 0n, Pass: 1n, Fail: 2n, Inconclusive: 3n };
const STATE = {
  None: 0n,
  Funded: 1n,
  Delivered: 2n,
  Verified: 3n,
  Disputed: 4n,
  Released: 5n,
  Refunded: 6n,
  Cancelled: 7n
};

const AMOUNT = 100_000n;
const BOND = 25_000n;
const CHALLENGER_BOND = 10_000n;
const DURATION = 7_200n;

const CANCELLATION_OFFER_TYPES = {
  CancellationOffer: [
    { name: "dealId", type: "uint256" },
    { name: "signer", type: "address" },
    { name: "revision", type: "uint32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiry", type: "uint64" }
  ]
};

async function fixture() {
  const [owner, buyer, seller, verifier, other] = await ethers.getSigners();

  const mockUSDCFactory = await ethers.getContractFactory("MockUSDC");
  const mockUSDC = (await mockUSDCFactory.connect(owner).deploy()) as Contract;
  await mockUSDC.waitForDeployment();

  // The spine tests only need the arbitrator to be a contract; the dispute path
  // (Phase 3) exercises a real IArbitratorV04 implementation.
  const arbitratorStandIn = (await mockUSDCFactory.connect(owner).deploy()) as Contract;
  await arbitratorStandIn.waitForDeployment();

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

  await mockUSDC.mint(await buyer.getAddress(), AMOUNT * 10n);
  await mockUSDC.connect(buyer).approve(await escrow.getAddress(), AMOUNT * 10n);
  await mockUSDC.mint(await seller.getAddress(), BOND * 10n);
  await mockUSDC.connect(seller).approve(await escrow.getAddress(), BOND * 10n);

  return { owner, buyer, seller, verifier, other, mockUSDC, arbitratorStandIn, escrow };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function openDefaultDeal(
  f: Fixture,
  options: Parameters<typeof openDealWithSellerAcceptanceV04>[12] = {}
) {
  return openDealWithSellerAcceptanceV04(
    f.escrow,
    f.buyer,
    f.seller,
    await f.seller.getAddress(),
    await f.verifier.getAddress(),
    await f.arbitratorStandIn.getAddress(),
    f.mockUSDC,
    AMOUNT,
    BOND,
    CHALLENGER_BOND,
    TERMS_HASH,
    DURATION,
    options
  );
}

async function deliverAndVerify(f: Fixture, dealId: bigint, verdict: bigint) {
  await f.escrow.connect(f.seller).postBond(dealId);
  await f.escrow.connect(f.seller).submitDelivery(dealId, EVIDENCE_HASH);
  await f.escrow.connect(f.verifier).recordVerification(dealId, verdict);
}

/**
 * Conservation check for a settled single-deal fixture: the escrow's recorded
 * liability equals the sum of all credits, and draining every credit leaves the
 * contract's token balance exactly zero.
 */
async function assertConservationAndDrain(f: Fixture, parties: Signer[]) {
  const token = f.mockUSDC;
  const escrowAddress = await f.escrow.getAddress();
  let creditSum = 0n;
  for (const party of parties) {
    creditSum += await f.escrow.withdrawable(
      await token.getAddress(),
      await party.getAddress()
    );
  }
  const [liabilities, actualBalance] = await f.escrow.tokenAccounting(
    await token.getAddress()
  );
  expect(liabilities).to.equal(creditSum);
  expect(actualBalance).to.equal(creditSum);
  for (const party of parties) {
    const credit = await f.escrow.withdrawable(
      await token.getAddress(),
      await party.getAddress()
    );
    if (credit > 0n) {
      await f.escrow.connect(party)["withdraw(address)"](await token.getAddress());
    }
  }
  expect(await token.balanceOf(escrowAddress)).to.equal(0n);
}

describe("SinettiEscrowV04 lifecycle", function () {
  describe("constructor", function () {
    it("rejects zero pauser, empty policies, zero token, codeless token, zero maxAmount, duplicate token", async function () {
      const { owner, mockUSDC } = await loadFixture(fixture);
      const factory = await ethers.getContractFactory("SinettiEscrowV04");
      const tokenAddress = await mockUSDC.getAddress();
      const policy = {
        token: tokenAddress,
        maxAmount: 1n,
        maxBond: 0n,
        minBondBps: 0,
        minChallengerBondBps: 0
      };

      await expect(
        factory.deploy(ethers.ZeroAddress, [policy], [], [], 60, 60)
      ).to.be.revertedWithCustomError(factory, "ZeroPauser");
      await expect(
        factory.deploy(await owner.getAddress(), [], [], [], 60, 60)
      ).to.be.revertedWithCustomError(factory, "NoTokenPolicies");
      await expect(
        factory.deploy(
          await owner.getAddress(),
          [{ ...policy, token: ethers.ZeroAddress }],
          [],
          [],
          60,
          60
        )
      ).to.be.revertedWithCustomError(factory, "ZeroToken");
      await expect(
        factory.deploy(
          await owner.getAddress(),
          [{ ...policy, token: await owner.getAddress() }],
          [],
          [],
          60,
          60
        )
      ).to.be.revertedWithCustomError(factory, "TokenHasNoCode");
      await expect(
        factory.deploy(await owner.getAddress(), [{ ...policy, maxAmount: 0n }], [], [], 60, 60)
      ).to.be.revertedWithCustomError(factory, "ZeroMaxAmount");
      await expect(
        factory.deploy(await owner.getAddress(), [policy, policy], [], [], 60, 60)
      ).to.be.revertedWithCustomError(factory, "DuplicateToken");
    });

    it("detects the real bond-policy conflict, not just maxBond == 0", async function () {
      const { owner, mockUSDC } = await loadFixture(fixture);
      const factory = await ethers.getContractFactory("SinettiEscrowV04");
      const tokenAddress = await mockUSDC.getAddress();

      // Every deal above amount 50 would otherwise be silently unopenable:
      // minBond = ceil(amount * 10%) exceeds maxBond = 5.
      await expect(
        factory.deploy(
          await owner.getAddress(),
          [{ token: tokenAddress, maxAmount: 10n ** 12n, maxBond: 5n, minBondBps: 1000, minChallengerBondBps: 0 }],
          [],
          [],
          60,
          60
        )
      ).to.be.revertedWithCustomError(factory, "UnsatisfiableBondPolicy");

      // The worst-case demand exactly equals the cap: satisfiable, deploys.
      const escrow = await factory.deploy(
        await owner.getAddress(),
        [{ token: tokenAddress, maxAmount: 1000n, maxBond: 100n, minBondBps: 1000, minChallengerBondBps: 0 }],
        [],
        [],
        60,
        60
      );
      await escrow.waitForDeployment();
      expect(await escrow.minBondBpsOf(tokenAddress)).to.equal(100n * 10n);
    });

    it("allowlist cardinality: needs three EOA roles and at least one arbitrator contract", async function () {
      const { owner, buyer, seller, verifier, mockUSDC, arbitratorStandIn } =
        await loadFixture(fixture);
      const factory = await ethers.getContractFactory("SinettiEscrowV04");
      const policy = {
        token: await mockUSDC.getAddress(),
        maxAmount: 1n,
        maxBond: 0n,
        minBondBps: 0,
        minChallengerBondBps: 0
      };
      const [b, s, v] = [
        await buyer.getAddress(),
        await seller.getAddress(),
        await verifier.getAddress()
      ];
      const arb = await arbitratorStandIn.getAddress();

      await expect(
        factory.deploy(await owner.getAddress(), [policy], [b, s], [arb], 60, 60)
      ).to.be.revertedWithCustomError(factory, "InsufficientParticipants");
      await expect(
        factory.deploy(await owner.getAddress(), [policy], [b, s, v], [], 60, 60)
      ).to.be.revertedWithCustomError(factory, "NoArbitrators");
      await expect(
        factory.deploy(await owner.getAddress(), [policy], [b, s, v], [ethers.ZeroAddress], 60, 60)
      ).to.be.revertedWithCustomError(factory, "ZeroArbitratorEntry");
      await expect(
        factory.deploy(await owner.getAddress(), [policy], [b, s, v], [arb, arb], 60, 60)
      ).to.be.revertedWithCustomError(factory, "DuplicateArbitrator");

      const escrow = await factory.deploy(
        await owner.getAddress(),
        [policy],
        [b, s, v],
        [arb],
        60,
        60
      );
      await escrow.waitForDeployment();
      expect(await escrow.participantAllowlistEnabled()).to.equal(true);
      expect(await escrow.listedArbitrator(arb)).to.equal(true);
    });

    it("pins the V04 constants and this fixture's deployed floors", async function () {
      const { escrow } = await loadFixture(fixture);
      expect(await escrow.SIGNING_DOMAIN_VERSION()).to.equal("8");
      // The 60-second absolute floor supports fast local demonstrations. It is
      // not a recommended public deployment setting; the default stays 3600.
      expect(await escrow.ABSOLUTE_MIN_CHALLENGE_WINDOW()).to.equal(60n);
      expect(await escrow.ABSOLUTE_MIN_RULING_WINDOW()).to.equal(60n);
      // This fixture deploys at the absolute floor; higher-assurance uses should choose higher.
      expect(await escrow.minChallengeWindow()).to.equal(60n);
      expect(await escrow.minRulingWindow()).to.equal(60n);
      expect(await escrow.DEFAULT_CHALLENGE_WINDOW()).to.equal(3600n);
      expect(await escrow.MAX_CHALLENGE_WINDOW()).to.equal(30n * 86400n);
      expect(await escrow.MIN_DEAL_DURATION()).to.equal(300n);
      expect(await escrow.MAX_DEAL_DURATION()).to.equal(365n * 86400n);
      expect(await escrow.MAX_RULING_WINDOW()).to.equal(90n * 86400n);
    });

    it("rejects window floors outside the hard bounds and honours a raised floor", async function () {
      const { owner, mockUSDC } = await loadFixture(fixture);
      const factory = await ethers.getContractFactory("SinettiEscrowV04");
      const policy = {
        token: await mockUSDC.getAddress(),
        maxAmount: 1n,
        maxBond: 0n,
        minBondBps: 0,
        minChallengerBondBps: 0
      };
      const deployer = await owner.getAddress();

      await expect(
        factory.deploy(deployer, [policy], [], [], 59, 60)
      ).to.be.revertedWithCustomError(factory, "ChallengeWindowFloorOutOfBounds");
      await expect(
        factory.deploy(deployer, [policy], [], [], 30n * 86400n + 1n, 60)
      ).to.be.revertedWithCustomError(factory, "ChallengeWindowFloorOutOfBounds");
      await expect(
        factory.deploy(deployer, [policy], [], [], 60, 59)
      ).to.be.revertedWithCustomError(factory, "RulingWindowFloorOutOfBounds");
      await expect(
        factory.deploy(deployer, [policy], [], [], 60, 90n * 86400n + 1n)
      ).to.be.revertedWithCustomError(factory, "RulingWindowFloorOutOfBounds");

      const raised = await factory.deploy(deployer, [policy], [], [], 7200, 3600);
      await raised.waitForDeployment();
      expect(await raised.minChallengeWindow()).to.equal(7200n);
      expect(await raised.minRulingWindow()).to.equal(3600n);
    });

    it("rejects an unsatisfiable challenger-bond policy above 10000 bps", async function () {
      const { owner, mockUSDC } = await loadFixture(fixture);
      const factory = await ethers.getContractFactory("SinettiEscrowV04");
      const tokenAddress = await mockUSDC.getAddress();
      const policy = {
        token: tokenAddress,
        maxAmount: 1000n,
        maxBond: 1000n,
        minBondBps: 0,
        minChallengerBondBps: 10_001
      };

      await expect(
        factory.deploy(await owner.getAddress(), [policy], [], [], 60, 60)
      ).to.be.revertedWithCustomError(factory, "UnsatisfiableChallengerBondPolicy");

      // Exactly 10000 bps (challenger bond == full principal) is the legal maximum.
      const escrow = await factory.deploy(
        await owner.getAddress(),
        [{ ...policy, minChallengerBondBps: 10_000 }],
        [],
        [],
        60,
        60
      );
      await escrow.waitForDeployment();
      expect(await escrow.minChallengerBondBpsOf(tokenAddress)).to.equal(10_000n);
    });
  });

  describe("openDeal", function () {
    it("opens Funded with the duration clock started at open, all fields stored, DealOpened emitted", async function () {
      const f = await loadFixture(fixture);
      const tx = await openDefaultDeal(f, {
        buyerIdentityRef: BUYER_ID_REF,
        sellerIdentityRef: SELLER_ID_REF,
        verifierIdentityRef: VERIFIER_ID_REF,
        arbitratorIdentityRef: ARBITRATOR_ID_REF
      });
      const openedAt = BigInt(await time.latest());

      await expect(tx)
        .to.emit(f.escrow, "DealOpened")
        .withArgs(
          1n,
          await f.buyer.getAddress(),
          await f.seller.getAddress(),
          await f.verifier.getAddress(),
          await f.arbitratorStandIn.getAddress(),
          await f.mockUSDC.getAddress(),
          AMOUNT,
          BOND,
          CHALLENGER_BOND,
          TERMS_HASH,
          BUYER_ID_REF,
          SELLER_ID_REF,
          VERIFIER_ID_REF,
          ARBITRATOR_ID_REF,
          openedAt + DURATION,
          DEFAULT_CHALLENGE_WINDOW,
          DEFAULT_RULING_WINDOW
        );

      const deal = await f.escrow.getDeal(1n);
      expect(deal.state).to.equal(STATE.Funded);
      expect(deal.deadline).to.equal(openedAt + DURATION);
      expect(deal.challengerBond).to.equal(CHALLENGER_BOND);
      expect(deal.termsHash).to.equal(TERMS_HASH);
      expect(deal.buyerIdentityRef).to.equal(BUYER_ID_REF);
      expect(deal.sellerIdentityRef).to.equal(SELLER_ID_REF);
      expect(deal.verdict).to.equal(VERDICT.None);
      expect(deal.revision).to.equal(1n);
      expect(await f.escrow.tokenLiability(await f.mockUSDC.getAddress())).to.equal(AMOUNT);
    });

    it("emits MetaEvidence only when the signed URI is non-empty", async function () {
      const f = await loadFixture(fixture);
      await expect(openDefaultDeal(f)).to.not.emit(f.escrow, "MetaEvidence");
      await expect(
        openDefaultDeal(f, { metaEvidenceURI: "ipfs://meta-evidence-doc" })
      )
        .to.emit(f.escrow, "MetaEvidence")
        .withArgs(2n, "ipfs://meta-evidence-doc");
    });

    it("enforces the duration bounds at both boundaries", async function () {
      const f = await loadFixture(fixture);
      await expect(
        openDefaultDeal(f, undefined) // sanity: defaults open fine
      ).to.not.be.revert(ethers);
      await expect(
        openDealWithSellerAcceptanceV04(
          f.escrow, f.buyer, f.seller,
          await f.seller.getAddress(), await f.verifier.getAddress(),
          await f.arbitratorStandIn.getAddress(), f.mockUSDC,
          AMOUNT, BOND, CHALLENGER_BOND, TERMS_HASH, 299n
        )
      ).to.be.revertedWithCustomError(f.escrow, "DurationOutOfBounds");
      await expect(
        openDealWithSellerAcceptanceV04(
          f.escrow, f.buyer, f.seller,
          await f.seller.getAddress(), await f.verifier.getAddress(),
          await f.arbitratorStandIn.getAddress(), f.mockUSDC,
          AMOUNT, BOND, CHALLENGER_BOND, TERMS_HASH, 365n * 86400n + 1n
        )
      ).to.be.revertedWithCustomError(f.escrow, "DurationOutOfBounds");
      await expect(
        openDealWithSellerAcceptanceV04(
          f.escrow, f.buyer, f.seller,
          await f.seller.getAddress(), await f.verifier.getAddress(),
          await f.arbitratorStandIn.getAddress(), f.mockUSDC,
          AMOUNT, BOND, CHALLENGER_BOND, TERMS_HASH, 300n
        )
      ).to.not.be.revert(ethers);
    });

    it("bounds the challenger bond to (0, amount]", async function () {
      const f = await loadFixture(fixture);
      await expect(
        openDealWithSellerAcceptanceV04(
          f.escrow, f.buyer, f.seller,
          await f.seller.getAddress(), await f.verifier.getAddress(),
          await f.arbitratorStandIn.getAddress(), f.mockUSDC,
          AMOUNT, BOND, 0n, TERMS_HASH, DURATION
        )
      ).to.be.revertedWithCustomError(f.escrow, "ChallengerBondOutOfBounds");
      await expect(
        openDealWithSellerAcceptanceV04(
          f.escrow, f.buyer, f.seller,
          await f.seller.getAddress(), await f.verifier.getAddress(),
          await f.arbitratorStandIn.getAddress(), f.mockUSDC,
          AMOUNT, BOND, AMOUNT + 1n, TERMS_HASH, DURATION
        )
      ).to.be.revertedWithCustomError(f.escrow, "ChallengerBondOutOfBounds");
      await expect(
        openDealWithSellerAcceptanceV04(
          f.escrow, f.buyer, f.seller,
          await f.seller.getAddress(), await f.verifier.getAddress(),
          await f.arbitratorStandIn.getAddress(), f.mockUSDC,
          AMOUNT, BOND, AMOUNT, TERMS_HASH, DURATION
        )
      ).to.not.be.revert(ethers);
    });

    it("enforces the challenge-window floor of 60 and the ruling-window bounds", async function () {
      const f = await loadFixture(fixture);
      await expect(
        openDefaultDeal(f, { challengeWindow: 59n })
      ).to.be.revertedWithCustomError(f.escrow, "ChallengeWindowTooShort");
      await expect(openDefaultDeal(f, { challengeWindow: 60n })).to.not.be.revert(ethers);
      await expect(
        openDefaultDeal(f, { rulingWindow: 59n })
      ).to.be.revertedWithCustomError(f.escrow, "RulingWindowOutOfBounds");
      await expect(
        openDefaultDeal(f, { rulingWindow: 90n * 86400n + 1n })
      ).to.be.revertedWithCustomError(f.escrow, "RulingWindowOutOfBounds");
      await expect(openDefaultDeal(f, { rulingWindow: 60n })).to.not.be.revert(ethers);
    });

    it("rejects an EOA arbitrator: the judge must be a contract", async function () {
      const f = await loadFixture(fixture);
      await expect(
        openDealWithSellerAcceptanceV04(
          f.escrow, f.buyer, f.seller,
          await f.seller.getAddress(), await f.verifier.getAddress(),
          await f.other.getAddress(), f.mockUSDC,
          AMOUNT, BOND, CHALLENGER_BOND, TERMS_HASH, DURATION
        )
      ).to.be.revertedWithCustomError(f.escrow, "ArbitratorHasNoCode");
    });

    it("rejects wrong opener, expired acceptance, duplicate parties, replayed acceptance", async function () {
      const f = await loadFixture(fixture);
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const now = BigInt(await time.latest());
      const signed = await sellerAcceptanceV04(
        f.escrow,
        chainId,
        f.seller,
        await f.buyer.getAddress(),
        await f.seller.getAddress(),
        await f.verifier.getAddress(),
        await f.arbitratorStandIn.getAddress(),
        await f.mockUSDC.getAddress(),
        AMOUNT,
        BOND,
        CHALLENGER_BOND,
        TERMS_HASH,
        DURATION,
        now + 600n
      );

      await expect(
        f.escrow.connect(f.other).openDeal(signed.acceptance, signed.signature)
      ).to.be.revertedWithCustomError(f.escrow, "NotBuyer");

      await time.increase(601n);
      await expect(
        f.escrow.connect(f.buyer).openDeal(signed.acceptance, signed.signature)
      ).to.be.revertedWithCustomError(f.escrow, "AcceptanceExpired");

      await expect(
        openDealWithSellerAcceptanceV04(
          f.escrow, f.buyer, f.seller,
          await f.seller.getAddress(), await f.seller.getAddress(),
          await f.arbitratorStandIn.getAddress(), f.mockUSDC,
          AMOUNT, BOND, CHALLENGER_BOND, TERMS_HASH, DURATION
        )
      ).to.be.revertedWithCustomError(f.escrow, "DuplicateParty");

      await openDefaultDeal(f);
      const replayable = await sellerAcceptanceV04(
        f.escrow, chainId, f.seller,
        await f.buyer.getAddress(), await f.seller.getAddress(),
        await f.verifier.getAddress(), await f.arbitratorStandIn.getAddress(),
        await f.mockUSDC.getAddress(),
        AMOUNT, BOND, CHALLENGER_BOND, TERMS_HASH, DURATION,
        BigInt(await time.latest()) + 600n
      );
      await f.escrow.connect(f.buyer).openDeal(replayable.acceptance, replayable.signature);
      await expect(
        f.escrow.connect(f.buyer).openDeal(replayable.acceptance, replayable.signature)
      ).to.be.revertedWithCustomError(f.escrow, "AcceptanceAlreadyConsumed");
    });

    it("rejects a signature made under the superseded domain version 7 and its 17-field type", async function () {
      const f = await loadFixture(fixture);
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const now = BigInt(await time.latest());
      const { acceptance } = await sellerAcceptanceV04(
        f.escrow, chainId, f.seller,
        await f.buyer.getAddress(), await f.seller.getAddress(),
        await f.verifier.getAddress(), await f.arbitratorStandIn.getAddress(),
        await f.mockUSDC.getAddress(),
        AMOUNT, BOND, CHALLENGER_BOND, TERMS_HASH, DURATION, now + 600n
      );
      const staleDomainSignature = await f.seller.signTypedData(
        {
          name: "SinettiEscrow",
          // The immediately superseded domain: version 7 with the earlier
          // 17-field struct is exactly what stale tooling would still produce.
          version: "7",
          chainId,
          verifyingContract: await f.escrow.getAddress()
        },
        {
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
            { name: "duration", type: "uint64" },
            { name: "challengeWindow", type: "uint64" },
            { name: "rulingWindow", type: "uint64" },
            { name: "openBy", type: "uint64" },
            { name: "salt", type: "bytes32" },
            { name: "metaEvidenceURI", type: "string" }
          ]
        },
        acceptance
      );
      await expect(
        f.escrow.connect(f.buyer).openDeal(acceptance, staleDomainSignature)
      ).to.be.revertedWithCustomError(f.escrow, "InvalidSellerSignature");
    });

    it("pause blocks openDeal and only openDeal", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await f.escrow.connect(f.owner).pause();

      await expect(openDefaultDeal(f)).to.be.revertedWithCustomError(
        f.escrow,
        "ContractIsPaused"
      );
      // The existing deal keeps moving while paused.
      await f.escrow.connect(f.seller).postBond(1n);
      await f.escrow.connect(f.seller).submitDelivery(1n, EVIDENCE_HASH);
      await f.escrow.connect(f.verifier).recordVerification(1n, VERDICT.Pass);
      await f.escrow.connect(f.buyer).accept(1n);
      expect((await f.escrow.getDeal(1n)).state).to.equal(STATE.Released);
    });
  });

  describe("revokeAcceptance", function () {
    it("lets the seller kill an unspent acceptance; nobody else; not twice", async function () {
      const f = await loadFixture(fixture);
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const signed = await sellerAcceptanceV04(
        f.escrow, chainId, f.seller,
        await f.buyer.getAddress(), await f.seller.getAddress(),
        await f.verifier.getAddress(), await f.arbitratorStandIn.getAddress(),
        await f.mockUSDC.getAddress(),
        AMOUNT, BOND, CHALLENGER_BOND, TERMS_HASH, DURATION,
        BigInt(await time.latest()) + 600n
      );

      await expect(
        f.escrow.connect(f.other).revokeAcceptance(signed.acceptance)
      ).to.be.revertedWithCustomError(f.escrow, "NotSeller");
      await expect(f.escrow.connect(f.seller).revokeAcceptance(signed.acceptance)).to.emit(
        f.escrow,
        "AcceptanceRevoked"
      );
      await expect(
        f.escrow.connect(f.buyer).openDeal(signed.acceptance, signed.signature)
      ).to.be.revertedWithCustomError(f.escrow, "AcceptanceAlreadyConsumed");
      await expect(
        f.escrow.connect(f.seller).revokeAcceptance(signed.acceptance)
      ).to.be.revertedWithCustomError(f.escrow, "AcceptanceAlreadyConsumed");
    });
  });

  describe("bond and delivery", function () {
    it("postBond then submitDelivery advances to Delivered and bumps the revision", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);

      await expect(f.escrow.connect(f.seller).postBond(1n))
        .to.emit(f.escrow, "BondPosted")
        .withArgs(1n, BOND);
      expect((await f.escrow.getDeal(1n)).revision).to.equal(2n);

      await expect(f.escrow.connect(f.seller).submitDelivery(1n, EVIDENCE_HASH))
        .to.emit(f.escrow, "DeliverySubmitted")
        .withArgs(1n, EVIDENCE_HASH);
      const deal = await f.escrow.getDeal(1n);
      expect(deal.state).to.equal(STATE.Delivered);
      expect(deal.revision).to.equal(3n);
      expect(await f.escrow.tokenLiability(await f.mockUSDC.getAddress())).to.equal(
        AMOUNT + BOND
      );
    });

    it("delivery requires the bond when one is signed, and the deadline gates both", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);

      await expect(
        f.escrow.connect(f.seller).submitDelivery(1n, EVIDENCE_HASH)
      ).to.be.revertedWithCustomError(f.escrow, "BondMissing");
      await expect(
        f.escrow.connect(f.seller).submitDelivery(1n, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(f.escrow, "ZeroEvidence");
      await expect(
        f.escrow.connect(f.other).postBond(1n)
      ).to.be.revertedWithCustomError(f.escrow, "NotSeller");

      await time.increase(DURATION + 1n);
      await expect(
        f.escrow.connect(f.seller).postBond(1n)
      ).to.be.revertedWithCustomError(f.escrow, "DeadlinePassed");
      await expect(
        f.escrow.connect(f.seller).submitDelivery(1n, EVIDENCE_HASH)
      ).to.be.revertedWithCustomError(f.escrow, "DeadlinePassed");
    });
  });

  describe("recordVerification stores the verdict", function () {
    it("stores Pass with verifiedAt and emits the challenge-window end", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await f.escrow.connect(f.seller).postBond(1n);
      await f.escrow.connect(f.seller).submitDelivery(1n, EVIDENCE_HASH);

      const tx = await f.escrow.connect(f.verifier).recordVerification(1n, VERDICT.Pass);
      const verifiedAt = BigInt(await time.latest());
      await expect(tx)
        .to.emit(f.escrow, "VerificationRecorded")
        .withArgs(
          1n,
          await f.verifier.getAddress(),
          VERDICT.Pass,
          verifiedAt,
          verifiedAt + DEFAULT_CHALLENGE_WINDOW
        );

      const deal = await f.escrow.getDeal(1n);
      expect(deal.state).to.equal(STATE.Verified);
      expect(deal.verdict).to.equal(VERDICT.Pass);
      expect(deal.verifiedAt).to.equal(verifiedAt);
      expect(await f.escrow.challengeEndsAt(1n)).to.equal(
        verifiedAt + DEFAULT_CHALLENGE_WINDOW
      );
    });

    it("stores Fail and Inconclusive as distinct verdicts", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await deliverAndVerify(f, 1n, VERDICT.Fail);
      expect((await f.escrow.getDeal(1n)).verdict).to.equal(VERDICT.Fail);

      await openDefaultDeal(f);
      await deliverAndVerify(f, 2n, VERDICT.Inconclusive);
      expect((await f.escrow.getDeal(2n)).verdict).to.equal(VERDICT.Inconclusive);
    });

    it("guards: verifier only, Delivered only, before the deadline, valid verdict range", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await expect(
        f.escrow.connect(f.verifier).recordVerification(1n, VERDICT.Pass)
      ).to.be.revertedWithCustomError(f.escrow, "DealNotDelivered");

      await f.escrow.connect(f.seller).postBond(1n);
      await f.escrow.connect(f.seller).submitDelivery(1n, EVIDENCE_HASH);
      await expect(
        f.escrow.connect(f.other).recordVerification(1n, VERDICT.Pass)
      ).to.be.revertedWithCustomError(f.escrow, "NotVerifier");
      await expect(
        f.escrow.connect(f.verifier).recordVerification(1n, 0n)
      ).to.be.revertedWithCustomError(f.escrow, "InvalidVerdict");
      await expect(
        f.escrow.connect(f.verifier).recordVerification(1n, 4n)
      ).to.be.revertedWithCustomError(f.escrow, "InvalidVerdict");

      await time.increase(DURATION + 1n);
      await expect(
        f.escrow.connect(f.verifier).recordVerification(1n, VERDICT.Pass)
      ).to.be.revertedWithCustomError(f.escrow, "DeadlinePassed");
    });

    it("a last-second verdict still opens one full challenge window", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await f.escrow.connect(f.seller).postBond(1n);
      await f.escrow.connect(f.seller).submitDelivery(1n, EVIDENCE_HASH);
      const deal = await f.escrow.getDeal(1n);

      // Move to two seconds before the deadline, then record: the horizon extends.
      await time.increaseTo(deal.deadline - 2n);
      await f.escrow.connect(f.verifier).recordVerification(1n, VERDICT.Fail);
      const verifiedAt = BigInt(await time.latest());
      expect(await f.escrow.challengeEndsAt(1n)).to.equal(
        verifiedAt + DEFAULT_CHALLENGE_WINDOW
      );

      // The deal can no longer be timed out from under the loser...
      await time.increaseTo(deal.deadline + 1n);
      await expect(f.escrow.claimTimeout(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "DealNotActive"
      );
      // ...and cannot settle until the full window has run.
      await expect(f.escrow.finalize(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "FinalizationNotReady"
      );
      await time.increaseTo(verifiedAt + DEFAULT_CHALLENGE_WINDOW);
      await f.escrow.finalize(1n);
      expect((await f.escrow.getDeal(1n)).state).to.equal(STATE.Refunded);
    });
  });

  describe("accept", function () {
    it("settles a Pass immediately: seller credited amount + bond, Settled(accepted)", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await deliverAndVerify(f, 1n, VERDICT.Pass);

      await expect(f.escrow.connect(f.buyer).accept(1n))
        .to.emit(f.escrow, "Settled")
        .withArgs(1n, REASON.accepted, AMOUNT + BOND, 0n);
      expect((await f.escrow.getDeal(1n)).state).to.equal(STATE.Released);
      expect(
        await f.escrow.withdrawable(
          await f.mockUSDC.getAddress(),
          await f.seller.getAddress()
        )
      ).to.equal(AMOUNT + BOND);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("deliberately has no time bound: a late cooperative buyer still lands 'accepted'", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await deliverAndVerify(f, 1n, VERDICT.Pass);

      await time.increase(DEFAULT_CHALLENGE_WINDOW * 3n);
      await expect(f.escrow.connect(f.buyer).accept(1n))
        .to.emit(f.escrow, "Settled")
        .withArgs(1n, REASON.accepted, AMOUNT + BOND, 0n);
    });

    it("guards: buyer only, Verified only, Pass only; terminal races revert cleanly", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await expect(f.escrow.connect(f.buyer).accept(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "DealNotVerified"
      );
      await deliverAndVerify(f, 1n, VERDICT.Fail);
      await expect(f.escrow.connect(f.buyer).accept(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "VerdictNotPass"
      );

      await openDefaultDeal(f);
      await deliverAndVerify(f, 2n, VERDICT.Pass);
      await expect(f.escrow.connect(f.other).accept(2n)).to.be.revertedWithCustomError(
        f.escrow,
        "NotBuyer"
      );
      await time.increase(DEFAULT_CHALLENGE_WINDOW + 1n);
      await f.escrow.finalize(2n);
      // finalize won the race; the buyer's late accept meets the state guard.
      await expect(f.escrow.connect(f.buyer).accept(2n)).to.be.revertedWithCustomError(
        f.escrow,
        "DealNotVerified"
      );
    });
  });

  describe("finalize executes the standing verdict", function () {
    it("Pass: Settled(verdict_pass, A+B, 0), callable by anyone", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await deliverAndVerify(f, 1n, VERDICT.Pass);
      await expect(f.escrow.finalize(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "FinalizationNotReady"
      );
      await time.increase(DEFAULT_CHALLENGE_WINDOW + 1n);
      await expect(f.escrow.connect(f.other).finalize(1n))
        .to.emit(f.escrow, "Settled")
        .withArgs(1n, REASON.verdictPass, AMOUNT + BOND, 0n);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("Fail: refund with the bond returned unslashed - Settled(verdict_fail, B, A)", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await deliverAndVerify(f, 1n, VERDICT.Fail);
      await time.increase(DEFAULT_CHALLENGE_WINDOW + 1n);
      await expect(f.escrow.finalize(1n))
        .to.emit(f.escrow, "Settled")
        .withArgs(1n, REASON.verdictFail, BOND, AMOUNT);
      expect(
        await f.escrow.withdrawable(
          await f.mockUSDC.getAddress(),
          await f.buyer.getAddress()
        )
      ).to.equal(AMOUNT);
      expect(
        await f.escrow.withdrawable(
          await f.mockUSDC.getAddress(),
          await f.seller.getAddress()
        )
      ).to.equal(BOND);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("Inconclusive: identical routing under its own reason code", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await deliverAndVerify(f, 1n, VERDICT.Inconclusive);
      await time.increase(DEFAULT_CHALLENGE_WINDOW + 1n);
      await expect(f.escrow.finalize(1n))
        .to.emit(f.escrow, "Settled")
        .withArgs(1n, REASON.verdictInconclusive, BOND, AMOUNT);
    });

    it("cannot double-settle: finalize on a terminal deal reverts", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await deliverAndVerify(f, 1n, VERDICT.Pass);
      await time.increase(DEFAULT_CHALLENGE_WINDOW + 1n);
      await f.escrow.finalize(1n);
      await expect(f.escrow.finalize(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "FinalizationNotReady"
      );
    });

    it("challengeEndsAt is 0 before any verdict (fail-closed input)", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      expect(await f.escrow.challengeEndsAt(1n)).to.equal(0n);
      // No verdict: the deal times out; it never silently "finalizes".
      await time.increase(DURATION + 1n);
      await expect(f.escrow.finalize(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "FinalizationNotReady"
      );
      await f.escrow.claimTimeout(1n);
    });
  });

  describe("claimTimeout", function () {
    it("Funded unbonded: buyer refunded, Settled(timeout, 0, A)", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await time.increase(DURATION + 1n);
      await expect(f.escrow.connect(f.other).claimTimeout(1n))
        .to.emit(f.escrow, "Settled")
        .withArgs(1n, REASON.timeout, 0n, AMOUNT);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("Funded and Delivered bonded: the bond always returns on timeout", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await f.escrow.connect(f.seller).postBond(1n);
      await openDefaultDeal(f);
      await f.escrow.connect(f.seller).postBond(2n);
      await f.escrow.connect(f.seller).submitDelivery(2n, EVIDENCE_HASH);

      await time.increase(DURATION + 1n);
      await expect(f.escrow.claimTimeout(1n))
        .to.emit(f.escrow, "Settled")
        .withArgs(1n, REASON.timeout, BOND, AMOUNT);
      await expect(f.escrow.claimTimeout(2n))
        .to.emit(f.escrow, "Settled")
        .withArgs(2n, REASON.timeout, BOND, AMOUNT);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("guards: not before the deadline, not on Verified, not on terminal states", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await expect(f.escrow.claimTimeout(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "DeadlineNotReached"
      );
      await deliverAndVerify(f, 1n, VERDICT.Pass);
      await time.increase(DURATION + DEFAULT_CHALLENGE_WINDOW + 2n);
      await expect(f.escrow.claimTimeout(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "DealNotActive"
      );
      await f.escrow.finalize(1n);
      await expect(f.escrow.claimTimeout(1n)).to.be.revertedWithCustomError(
        f.escrow,
        "DealNotActive"
      );
    });
  });

  describe("cancelMutually binds to the deal revision", function () {
    async function signOffer(
      f: Fixture,
      signer: Signer,
      dealId: bigint,
      revision: bigint,
      overrides: Partial<Record<"issuedAt" | "expiry", bigint>> = {}
    ) {
      const now = BigInt(await time.latest());
      const offer = {
        dealId,
        signer: await signer.getAddress(),
        revision,
        nonce: ethers.hexlify(ethers.randomBytes(32)),
        issuedAt: overrides.issuedAt ?? now,
        expiry: overrides.expiry ?? now + 1800n
      };
      const signature = await signer.signTypedData(
        {
          name: "SinettiEscrow",
          version: "8",
          chainId: (await ethers.provider.getNetwork()).chainId,
          verifyingContract: await f.escrow.getAddress()
        },
        CANCELLATION_OFFER_TYPES,
        offer
      );
      return { offer, signature };
    }

    it("unwinds a bonded Funded deal: principal to buyer, bond to seller", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await f.escrow.connect(f.seller).postBond(1n);

      const { offer, signature } = await signOffer(f, f.seller, 1n, 2n);
      await expect(f.escrow.connect(f.buyer).cancelMutually(offer, signature))
        .to.emit(f.escrow, "Settled")
        .withArgs(1n, REASON.cancelled, BOND, AMOUNT);
      expect((await f.escrow.getDeal(1n)).state).to.equal(STATE.Cancelled);
      await assertConservationAndDrain(f, [f.buyer, f.seller, f.verifier]);
    });

    it("an offer signed against an older revision stops validating after the deal moves", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      const { offer, signature } = await signOffer(f, f.seller, 1n, 1n);

      await f.escrow.connect(f.seller).postBond(1n); // revision 1 -> 2
      await expect(
        f.escrow.connect(f.buyer).cancelMutually(offer, signature)
      ).to.be.revertedWithCustomError(f.escrow, "CancellationRevisionMismatch");
    });

    it("guards: only a party signs, only the counterparty accepts, lifetime bounds hold, no replay", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);

      const stranger = await signOffer(f, f.other, 1n, 1n);
      await expect(
        f.escrow.connect(f.buyer).cancelMutually(stranger.offer, stranger.signature)
      ).to.be.revertedWithCustomError(f.escrow, "InvalidCancellationSigner");

      const selfAccept = await signOffer(f, f.seller, 1n, 1n);
      await expect(
        f.escrow.connect(f.seller).cancelMutually(selfAccept.offer, selfAccept.signature)
      ).to.be.revertedWithCustomError(f.escrow, "InvalidCancellationSigner");

      const now = BigInt(await time.latest());
      const tooLong = await signOffer(f, f.seller, 1n, 1n, {
        issuedAt: now,
        expiry: now + 3601n
      });
      await expect(
        f.escrow.connect(f.buyer).cancelMutually(tooLong.offer, tooLong.signature)
      ).to.be.revertedWithCustomError(f.escrow, "CancellationOfferDurationTooLong");

      const notYet = await signOffer(f, f.seller, 1n, 1n, {
        issuedAt: now + 600n,
        expiry: now + 1200n
      });
      await expect(
        f.escrow.connect(f.buyer).cancelMutually(notYet.offer, notYet.signature)
      ).to.be.revertedWithCustomError(f.escrow, "CancellationOfferNotYetValid");

      const good = await signOffer(f, f.seller, 1n, 1n);
      await f.escrow.connect(f.buyer).cancelMutually(good.offer, good.signature);
      await expect(
        f.escrow.connect(f.buyer).cancelMutually(good.offer, good.signature)
      ).to.be.revertedWithCustomError(f.escrow, "CancellationOfferAlreadyConsumed");
    });

    it("cancellation is blocked on terminal deals", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await time.increase(DURATION + 1n);
      await f.escrow.claimTimeout(1n);
      const { offer, signature } = await signOffer(f, f.seller, 1n, 2n);
      await expect(
        f.escrow.connect(f.buyer).cancelMutually(offer, signature)
      ).to.be.revertedWithCustomError(f.escrow, "CancelNotAllowed");
    });
  });

  describe("withdraw", function () {
    it("supports partial withdrawal so one slice can never trap the rest", async function () {
      const f = await loadFixture(fixture);
      await openDefaultDeal(f);
      await deliverAndVerify(f, 1n, VERDICT.Pass);
      await f.escrow.connect(f.buyer).accept(1n);
      const tokenAddress = await f.mockUSDC.getAddress();

      await f.escrow.connect(f.seller)["withdraw(address,uint256)"](tokenAddress, 40_000n);
      expect(
        await f.escrow.withdrawable(tokenAddress, await f.seller.getAddress())
      ).to.equal(AMOUNT + BOND - 40_000n);
      await f.escrow.connect(f.seller)["withdraw(address)"](tokenAddress);
      expect(
        await f.escrow.withdrawable(tokenAddress, await f.seller.getAddress())
      ).to.equal(0n);
      expect(await f.mockUSDC.balanceOf(await f.escrow.getAddress())).to.equal(0n);
    });

    it("rejects zero, over-credit, and empty withdrawals", async function () {
      const f = await loadFixture(fixture);
      const tokenAddress = await f.mockUSDC.getAddress();
      await expect(
        f.escrow.connect(f.other)["withdraw(address)"](tokenAddress)
      ).to.be.revertedWithCustomError(f.escrow, "NothingToWithdraw");
      await expect(
        f.escrow.connect(f.other)["withdraw(address,uint256)"](tokenAddress, 1n)
      ).to.be.revertedWithCustomError(f.escrow, "NothingToWithdraw");

      await openDefaultDeal(f);
      await deliverAndVerify(f, 1n, VERDICT.Pass);
      await f.escrow.connect(f.buyer).accept(1n);
      await expect(
        f.escrow
          .connect(f.seller)
          ["withdraw(address,uint256)"](tokenAddress, AMOUNT + BOND + 1n)
      ).to.be.revertedWithCustomError(f.escrow, "NothingToWithdraw");
    });
  });

  describe("pauser handover", function () {
    it("two-step transfer with guards", async function () {
      const f = await loadFixture(fixture);
      await expect(f.escrow.connect(f.other).pause()).to.be.revertedWithCustomError(
        f.escrow,
        "NotPauser"
      );
      await expect(
        f.escrow.connect(f.other).transferPauser(await f.other.getAddress())
      ).to.be.revertedWithCustomError(f.escrow, "NotPauser");
      await expect(
        f.escrow.connect(f.owner).transferPauser(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(f.escrow, "ZeroPauser");

      await f.escrow.connect(f.owner).transferPauser(await f.other.getAddress());
      await expect(f.escrow.connect(f.buyer).acceptPauser()).to.be.revertedWithCustomError(
        f.escrow,
        "NotPendingPauser"
      );
      await f.escrow.connect(f.other).acceptPauser();
      expect(await f.escrow.pauser()).to.equal(await f.other.getAddress());
      await f.escrow.connect(f.other).pause();
      expect(await f.escrow.paused()).to.equal(true);
      await f.escrow.connect(f.other).unpause();
      expect(await f.escrow.paused()).to.equal(false);
    });
  });
});
