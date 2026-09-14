import { expect } from "chai";
import { Contract } from "ethers";
import { ethers } from "./helpers/hardhat";
import { loadFixture, time } from "./helpers/hardhat";
import { sellerAcceptanceV04 } from "./helpers/sellerAcceptanceV04";

const TERMS_HASH = ethers.encodeBytes32String("criteria+mandate");
const AMOUNT = 100_000n;
const BOND = 0n;
const CHALLENGER_BOND = 10_000n;
const DURATION = 7_200n;

async function fixture() {
  const [owner, buyer, sellerOwner, verifier, other] = await ethers.getSigners();

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

  await mockUSDC.mint(await buyer.getAddress(), AMOUNT * 10n);
  await mockUSDC.connect(buyer).approve(await escrow.getAddress(), AMOUNT * 10n);

  return { owner, buyer, sellerOwner, verifier, other, mockUSDC, arbitrator, escrow };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Sign a V04 acceptance with `sellerOwner`'s key on behalf of a contract seller. */
async function acceptanceForContractSeller(f: Fixture, sellerAddress: string) {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  return sellerAcceptanceV04(
    f.escrow,
    chainId,
    f.sellerOwner,
    await f.buyer.getAddress(),
    sellerAddress,
    await f.verifier.getAddress(),
    await f.arbitrator.getAddress(),
    await f.mockUSDC.getAddress(),
    AMOUNT,
    BOND,
    CHALLENGER_BOND,
    TERMS_HASH,
    DURATION,
    BigInt(await time.latest()) + 600n
  );
}

describe("SinettiEscrowV04 security (ERC-1271 boundary)", function () {
  it("accepts a realistic ERC-1271 contract seller owned by the signing key", async function () {
    const f = await loadFixture(fixture);
    const walletFactory = await ethers.getContractFactory("RealisticERC1271Wallet");
    const wallet = await walletFactory.deploy(await f.sellerOwner.getAddress());
    await wallet.waitForDeployment();

    const { acceptance, signature } = await acceptanceForContractSeller(
      f,
      await wallet.getAddress()
    );
    await expect(f.escrow.connect(f.buyer).openDeal(acceptance, signature)).to.emit(
      f.escrow,
      "DealOpened"
    );
  });

  it("rejects the same wallet when the signature comes from a non-owner", async function () {
    const f = await loadFixture(fixture);
    const walletFactory = await ethers.getContractFactory("RealisticERC1271Wallet");
    const wallet = await walletFactory.deploy(await f.other.getAddress());
    await wallet.waitForDeployment();

    const { acceptance, signature } = await acceptanceForContractSeller(
      f,
      await wallet.getAddress()
    );
    await expect(
      f.escrow.connect(f.buyer).openDeal(acceptance, signature)
    ).to.be.revertedWithCustomError(f.escrow, "InvalidSellerSignature");
  });

  it("rejects a wallet that reverts while returning the magic value", async function () {
    const f = await loadFixture(fixture);
    const walletFactory = await ethers.getContractFactory("RevertingMagicERC1271Wallet");
    const wallet = await walletFactory.deploy();
    await wallet.waitForDeployment();

    const { acceptance, signature } = await acceptanceForContractSeller(
      f,
      await wallet.getAddress()
    );
    await expect(
      f.escrow.connect(f.buyer).openDeal(acceptance, signature)
    ).to.be.revertedWithCustomError(f.escrow, "InvalidSellerSignature");
  });

    it("keeps caller gas independent of the wallet's returndata size", async function () {
    const f = await loadFixture(fixture);
    const walletFactory = await ethers.getContractFactory("ReturnBombERC1271Wallet");
    // Same wallet code, two reply sizes: one word, and 150KB (about the largest a
    // wallet can afford to return inside the 100k forwarded gas). The bomb leads
    // with the magic value, so both consents are "valid" - the attack was never
    // the answer, it was making the CALLER pay to copy it, which V03's
    // abi.decode(result, ...) did and the 32-byte bounded copy does not.
    const smallWallet = await walletFactory.deploy(32n);
    await smallWallet.waitForDeployment();
    const bombWallet = await walletFactory.deploy(150_000n);
    await bombWallet.waitForDeployment();

    const gasUsed: bigint[] = [];
    for (const wallet of [smallWallet, bombWallet]) {
      const { acceptance, signature } = await acceptanceForContractSeller(
        f,
        await wallet.getAddress()
      );
      const tx = await f.escrow.connect(f.buyer).openDeal(acceptance, signature);
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);
      gasUsed.push(receipt!.gasUsed);
    }
    // The wallet's own memory expansion is paid out of the forwarded allowance,
    // so the extra cost of ANY reply is bounded by ERC1271_GAS_LIMIT. Under
    // V03's unbounded abi.decode copy the caller paid a second, uncapped
    // expansion on top (about 117k total extra at this size), breaking the cap.
    const delta = gasUsed[1] > gasUsed[0] ? gasUsed[1] - gasUsed[0] : gasUsed[0] - gasUsed[1];
    expect(delta).to.be.lessThan(await f.escrow.ERC1271_GAS_LIMIT());
  });

  it("caps a gas-bomb wallet at ERC1271_GAS_LIMIT and rejects it without starving the caller", async function () {
    const f = await loadFixture(fixture);
    const walletFactory = await ethers.getContractFactory("GasBombERC1271Wallet");
    const wallet = await walletFactory.deploy();
    await wallet.waitForDeployment();

    const { acceptance, signature } = await acceptanceForContractSeller(
      f,
      await wallet.getAddress()
    );
    // The wallet burns everything forwarded; the 100k cap turns that into a
    // bounded cost and a clean rejection instead of an out-of-gas.
    await expect(
      f.escrow
        .connect(f.buyer)
        .openDeal(acceptance, signature, { gasLimit: 600_000n })
    ).to.be.revertedWithCustomError(f.escrow, "InvalidSellerSignature");
  });

  it("rejects short-return and wrong-magic wallet behaviours", async function () {
    const f = await loadFixture(fixture);
    const walletFactory = await ethers.getContractFactory("ConfigurableERC1271Wallet");
    const wallet = await walletFactory.deploy(await f.sellerOwner.getAddress());
    await wallet.waitForDeployment();

    // SignatureBehavior: 0 Valid, 1 Revert, 2 WrongMagic, 3 ShortReturn.
    for (const behavior of [3n, 2n, 1n]) {
      await wallet.connect(f.sellerOwner).setSignatureBehavior(behavior);
      const { acceptance, signature } = await acceptanceForContractSeller(
        f,
        await wallet.getAddress()
      );
      await expect(
        f.escrow.connect(f.buyer).openDeal(acceptance, signature)
      ).to.be.revertedWithCustomError(f.escrow, "InvalidSellerSignature");
    }

    await wallet.connect(f.sellerOwner).setSignatureBehavior(0n);
    const { acceptance, signature } = await acceptanceForContractSeller(
      f,
      await wallet.getAddress()
    );
    await expect(f.escrow.connect(f.buyer).openDeal(acceptance, signature)).to.emit(
      f.escrow,
      "DealOpened"
    );
  });
});
