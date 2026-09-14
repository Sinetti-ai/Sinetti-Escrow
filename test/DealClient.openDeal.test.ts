import { expect } from "chai";
import { Contract, FunctionFragment } from "ethers";
import { artifacts, ethers } from "./helpers/hardhat";
import { time } from "./helpers/hardhat";

import { ERC20_ABI, ESCROW_ABI, STATE, openDeal, postBond } from "../src/dealClient";
import { signSellerAcceptance } from "../src/sellerAcceptance";

const AMOUNT = 250_000_000n;
const BOND = 25_000_000n;

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

async function signed(context: Awaited<ReturnType<typeof fixture>>) {
  return signSellerAcceptance({
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
    challengerBond: 1_000_000n,
    termsHash: ethers.id("example terms"),
    duration: 7200n,
    challengeWindow: 60n,
    rulingWindow: 3600n,
    openBy: BigInt(await time.latest()) + 3600n
  });
}

describe("deal client — V04 opening and bond", function () {
  it("reads the assigned id from DealOpened and leaves no standing allowance", async function () {
    const context = await fixture();
    const escrowAddress = await context.escrow.getAddress();
    const buyerAddress = await context.buyer.getAddress();
    await context.token.mint(buyerAddress, AMOUNT * 2n);

    const first = await signed(context);
    const opened = await openDeal({
      escrowAddress,
      buyerSigner: context.buyer,
      terms: first.terms,
      signature: first.signature
    });
    expect(opened.dealId).to.equal(1n);
    expect(await context.token.allowance(buyerAddress, escrowAddress)).to.equal(0n);

    const second = await signed(context);
    expect((await openDeal({
      escrowAddress,
      buyerSigner: context.buyer,
      terms: second.terms,
      signature: second.signature
    })).dealId).to.equal(2n);
  });

  it("posts the exact seller bond and reads State through getDeal", async function () {
    const context = await fixture();
    const escrowAddress = await context.escrow.getAddress();
    await context.token.mint(await context.buyer.getAddress(), AMOUNT);
    await context.token.mint(await context.seller.getAddress(), BOND);
    const acceptance = await signed(context);
    const { dealId } = await openDeal({
      escrowAddress,
      buyerSigner: context.buyer,
      terms: acceptance.terms,
      signature: acceptance.signature
    });
    const result = await postBond({
      escrowAddress,
      sellerSigner: context.seller,
      dealId,
      token: await context.token.getAddress(),
      bond: BOND
    });
    expect(result.state).to.equal(STATE.Funded);
    expect((await context.escrow.getDeal(dealId)).bondPosted).to.equal(true);
  });
});

describe("deal client — hand-written ABI", function () {
  it("matches every V04 function and event fragment against the compiled artifact", async function () {
    const artifact = await artifacts.readArtifact("SinettiEscrowV04");
    const compiled = new ethers.Interface(artifact.abi);
    const client = new ethers.Interface(ESCROW_ABI);

    for (const fragment of client.fragments) {
      if (fragment.type === "function") {
        const signature = (fragment as FunctionFragment).format("sighash");
        const clientFn = client.getFunction(signature)!;
        const compiledFn = compiled.getFunction(signature);
        expect(compiledFn, `escrow has no function ${signature}`).to.not.equal(null);
        expect(clientFn.selector, `selector drift on ${signature}`).to.equal(
          compiledFn!.selector
        );
        expect(clientFn.outputs.map((output) => output.format("full"))).to.deep.equal(
          compiledFn!.outputs.map((output) => output.format("full"))
        );
      } else if (fragment.type === "event") {
        const signature = fragment.format("sighash");
        expect(client.getEvent(signature)!.topicHash).to.equal(
          compiled.getEvent(signature)!.topicHash
        );
      }
    }
  });

  it("uses explicit overloaded withdraw signatures", function () {
    const client = new ethers.Interface(ESCROW_ABI);
    expect(client.getFunction("withdraw(address)")).to.not.equal(null);
    expect(client.getFunction("withdraw(address,uint256)")).to.not.equal(null);
  });

  it("keeps the settlement-token fragments valid", async function () {
    const artifact = await artifacts.readArtifact("TestEUR");
    const compiled = new ethers.Interface(artifact.abi);
    const client = new ethers.Interface(ERC20_ABI);
    for (const fragment of client.fragments) {
      if (fragment.type !== "function") continue;
      const signature = (fragment as FunctionFragment).format("sighash");
      expect(client.getFunction(signature)!.selector).to.equal(
        compiled.getFunction(signature)!.selector
      );
    }
  });
});
