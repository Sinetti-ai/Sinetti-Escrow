import hre, { network } from "hardhat";

/**
 * One network connection shared by every Hardhat test file and helper. Hardhat 3
 * gives each `network.create()` call its own chain, so a second connection would
 * not see contracts deployed through the first.
 */
export const connection = await network.create();
export const { ethers, networkHelpers, networkName } = connection;
export const { artifacts } = hre;
export const { time } = networkHelpers;
export const loadFixture = networkHelpers.loadFixture.bind(networkHelpers);
export const takeSnapshot = networkHelpers.takeSnapshot.bind(networkHelpers);
