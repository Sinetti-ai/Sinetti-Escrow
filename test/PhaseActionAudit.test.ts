import { expect } from "chai";
import { Contract, Signer } from "ethers";
import { ethers } from "./helpers/hardhat";
import { loadFixture, takeSnapshot, time } from "./helpers/hardhat";

import { OUTCOME, STATE, VERDICT, openDeal, postBond, stateName } from "../src/dealClient";
import { assertActionAllowed, challengeVerdict } from "../src/dealLifecycle";
import type { LifecycleAction } from "../src/dealLifecycle";
import { signSellerAcceptance } from "../src/sellerAcceptance";

const AMOUNT = 100_000_000n;
const BOND = 10_000_000n;
const CHALLENGER_BOND = 1_000_000n;
const DURATION = 7200n;
const CHALLENGE_WINDOW = 60n;
const RULING_WINDOW = 172_800n;
const OVERRIDE_WINDOW = 86_400n;
const EVIDENCE_HASH = ethers.id("phase action audit evidence");

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

/**
 * Cross-checks the client's state-rule table against deployed V04 contracts.
 *
 * Every answer below comes from an eth_call against SinettiEscrowV04 or the
 * ConsoleArbitrator path that ultimately calls it. The calls execute exactly as a
 * transaction would, but their writes are discarded. That is the protection this
 * audit previously supplied: a plausible-looking client table cannot certify itself.
 */
async function fixture() {
  const [owner, buyer, seller, verifier, agent, officer, other] = await ethers.getSigners();

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
      CHALLENGE_WINDOW,
      OVERRIDE_WINDOW
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

  await (await token.mint(await buyer.getAddress(), AMOUNT * 20n)).wait();
  await (await token.mint(await seller.getAddress(), (BOND + CHALLENGER_BOND) * 20n)).wait();

  return { buyer, seller, verifier, agent, officer, other, token, escrow, arbitrator };
}

type Context = Awaited<ReturnType<typeof fixture>>;

async function openFunded(context: Context): Promise<bigint> {
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
    termsHash: ethers.id("phase action audit terms"),
    duration: DURATION,
    challengeWindow: CHALLENGE_WINDOW,
    rulingWindow: RULING_WINDOW,
    openBy: BigInt(await time.latest()) + DURATION
  });
  return (await openDeal({
    escrowAddress: await context.escrow.getAddress(),
    buyerSigner: context.buyer,
    terms,
    signature
  })).dealId;
}

async function bond(context: Context, dealId: bigint): Promise<void> {
  await postBond({
    escrowAddress: await context.escrow.getAddress(),
    sellerSigner: context.seller,
    dealId,
    token: await context.token.getAddress(),
    bond: BOND
  });
}

async function verified(
  context: Context,
  verdict: number = VERDICT.Pass
): Promise<bigint> {
  const dealId = await openFunded(context);
  await bond(context, dealId);
  await (await context.escrow.connect(context.seller).submitDelivery(
    dealId,
    EVIDENCE_HASH
  )).wait();
  await (await context.escrow.connect(context.verifier).recordVerification(
    dealId,
    verdict
  )).wait();
  return dealId;
}

async function disputed(context: Context): Promise<bigint> {
  const dealId = await verified(context);
  await challengeVerdict({
    escrowAddress: await context.escrow.getAddress(),
    signer: context.buyer,
    dealId
  });
  return dealId;
}

async function cancel(context: Context, dealId: bigint): Promise<void> {
  const deal = await context.escrow.getDeal(dealId);
  const now = BigInt(await time.latest());
  const offer = {
    dealId,
    signer: await context.seller.getAddress(),
    revision: deal.revision,
    nonce: ethers.hexlify(ethers.randomBytes(32)),
    issuedAt: now,
    expiry: now + 1800n
  };
  const signature = await context.seller.signTypedData(
    {
      name: "SinettiEscrow",
      version: "8",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await context.escrow.getAddress()
    },
    CANCELLATION_OFFER_TYPES,
    offer
  );
  await (await context.escrow.connect(context.buyer).cancelMutually(offer, signature)).wait();
}

type Recipe = { state: number; build: (context: Context) => Promise<bigint> };

const RECIPES: Recipe[] = [
  { state: STATE.None, build: async () => 999n },
  {
    state: STATE.Funded,
    build: async (context) => {
      const dealId = await openFunded(context);
      await bond(context, dealId);
      return dealId;
    }
  },
  {
    state: STATE.Delivered,
    build: async (context) => {
      const dealId = await openFunded(context);
      await bond(context, dealId);
      await (await context.escrow.connect(context.seller).submitDelivery(
        dealId,
        EVIDENCE_HASH
      )).wait();
      return dealId;
    }
  },
  { state: STATE.Verified, build: (context) => verified(context) },
  { state: STATE.Disputed, build: (context) => disputed(context) },
  {
    state: STATE.Released,
    build: async (context) => {
      const dealId = await verified(context);
      await (await context.escrow.connect(context.buyer).accept(dealId)).wait();
      return dealId;
    }
  },
  {
    state: STATE.Refunded,
    build: async (context) => {
      const dealId = await verified(context, VERDICT.Fail);
      await time.increase(CHALLENGE_WINDOW + 1n);
      await (await context.escrow.finalize(dealId)).wait();
      return dealId;
    }
  },
  {
    state: STATE.Cancelled,
    build: async (context) => {
      const dealId = await openFunded(context);
      await cancel(context, dealId);
      return dealId;
    }
  }
];

const ACTIONS: LifecycleAction[] = [
  "deliver",
  "verify",
  "accept",
  "challenge",
  "propose",
  "overturn",
  "push",
  "finalize",
  "timeout"
];

/** Put the same V04 state at the time boundary where this action can genuinely land. */
async function prepareAction(
  context: Context,
  dealId: bigint,
  state: number,
  action: LifecycleAction
): Promise<void> {
  if (action === "challenge" && state === STATE.Verified) {
    await (await context.token.connect(context.buyer).approve(
      await context.escrow.getAddress(),
      CHALLENGER_BOND
    )).wait();
  }
  if (action === "timeout" && (state === STATE.Funded || state === STATE.Delivered)) {
    await time.increaseTo(BigInt((await context.escrow.getDeal(dealId)).deadline) + 1n);
  }
  if (action === "finalize" && state === STATE.Verified) {
    await time.increaseTo(BigInt(await context.escrow.challengeEndsAt(dealId)) + 1n);
  }
  if (action === "finalize" && state === STATE.Disputed) {
    await time.increaseTo(BigInt((await context.escrow.disputes(dealId)).rulingDeadline) + 1n);
  }
}

/**
 * Console proposals exist only for a live Disputed deal that names this
 * arbitrator. The proposal call itself now enforces the same state and binding
 * that the eventual push relies on, so an officer window cannot start early.
 */
async function attemptConsoleAction(
  context: Context,
  dealId: bigint,
  action: "propose" | "overturn" | "push"
): Promise<void> {
  await context.arbitrator.connect(context.agent).propose.staticCall(dealId, OUTCOME.Release);
  await (await context.arbitrator.connect(context.agent).propose(
    dealId,
    OUTCOME.Release
  )).wait();

  if (action === "overturn") {
    await context.arbitrator.connect(context.officer).overturn.staticCall(
      dealId,
      OUTCOME.Refund
    );
    await (await context.arbitrator.connect(context.officer).overturn(
      dealId,
      OUTCOME.Refund
    )).wait();
  }

  await time.increase(OVERRIDE_WINDOW + 1n);
  await context.arbitrator.connect(context.other).push.staticCall(dealId);
}

async function attempt(
  context: Context,
  action: LifecycleAction,
  dealId: bigint
): Promise<void> {
  switch (action) {
    case "deliver":
      await context.escrow.connect(context.seller).submitDelivery.staticCall(
        dealId,
        EVIDENCE_HASH
      );
      return;
    case "verify":
      await context.escrow.connect(context.verifier).recordVerification.staticCall(
        dealId,
        VERDICT.Pass
      );
      return;
    case "accept":
      await context.escrow.connect(context.buyer).accept.staticCall(dealId);
      return;
    case "challenge":
      await context.escrow.connect(context.buyer).challenge.staticCall(dealId);
      return;
    case "propose":
    case "overturn":
    case "push":
      await attemptConsoleAction(context, dealId, action);
      return;
    case "finalize":
      await context.escrow.connect(context.other).finalize.staticCall(dealId);
      return;
    case "timeout":
      await context.escrow.connect(context.other).claimTimeout.staticCall(dealId);
      return;
  }
}

async function contractAllows(
  context: Context,
  dealId: bigint,
  state: number,
  action: LifecycleAction
): Promise<boolean> {
  await prepareAction(context, dealId, state, action);
  try {
    await attempt(context, action, dealId);
    return true;
  } catch {
    return false;
  }
}

function ruleAllows(action: LifecycleAction, state: number): boolean {
  try {
    assertActionAllowed(action, state, { bond: 0n });
    return true;
  } catch {
    return false;
  }
}

describe("V04 state action rules, against the contracts", function () {
  for (const recipe of RECIPES) {
    it(`offers exactly what V04 allows in ${stateName(recipe.state)}`, async function () {
      const context = await loadFixture(fixture);
      const dealId = await recipe.build(context);
      expect(Number((await context.escrow.getDeal(dealId)).state), "recipe built wrong state")
        .to.equal(recipe.state);

      const disagreements: string[] = [];
      let snapshot = await takeSnapshot();
      for (const action of ACTIONS) {
        const chain = await contractAllows(context, dealId, recipe.state, action);
        const client = ruleAllows(action, recipe.state);
        if (chain !== client) {
          disagreements.push(
            client
              ? `${action}: the client offers it, the contract path reverts`
              : `${action}: the contract path succeeds, the client refuses`
          );
        }
        await snapshot.restore();
        snapshot = await takeSnapshot();
      }

      expect(disagreements, `in ${stateName(recipe.state)}`).to.deep.equal([]);
    });
  }

  it("audits every V04 State exactly once", function () {
    const audited = RECIPES.map((recipe) => recipe.state);
    expect(new Set(audited).size, "a state is audited twice").to.equal(audited.length);
    expect(audited.sort((a, b) => a - b)).to.deep.equal(
      Object.values(STATE).sort((a, b) => a - b)
    );
  });

  it("keeps the required-bond preflight inside Funded", function () {
    expect(() => assertActionAllowed("deliver", STATE.Funded, { bond: 1n })).to.throw(
      /requires a seller bond/i
    );
  });
});
