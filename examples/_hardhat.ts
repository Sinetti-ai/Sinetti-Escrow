import { network } from "hardhat";

/**
 * One network connection shared by the examples. `hardhat run --network sepolia`
 * selects the network; with no flag this is the in-process Hardhat chain.
 */
export const connection = await network.create();
export const { ethers, networkHelpers, networkName } = connection;
export const { time } = networkHelpers;
