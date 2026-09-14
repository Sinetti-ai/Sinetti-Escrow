import { expect } from "chai";
import { ethers } from "./helpers/hardhat";

describe("TestEUR", () => {
  it("has euro test-token metadata and 6 decimals", async () => {
    const TestEUR = await ethers.getContractFactory("TestEUR");
    const teur = await TestEUR.deploy();
    expect(await teur.name()).to.equal("Test Euro");
    expect(await teur.symbol()).to.equal("tEUR");
    expect(await teur.decimals()).to.equal(6);
  });

  it("mints freely as a test faucet", async () => {
    const [_, alice] = await ethers.getSigners();
    const TestEUR = await ethers.getContractFactory("TestEUR");
    const teur = await TestEUR.deploy();
    await teur.mint(alice.address, 250_000_000n); // EUR 250.00
    expect(await teur.balanceOf(alice.address)).to.equal(250_000_000n);
  });
});
