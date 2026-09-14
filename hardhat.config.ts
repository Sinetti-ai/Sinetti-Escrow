import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig } from "hardhat/config";

// No .env loader here: dotenv is not a dependency of this repo. Export
// variables to the shell before running (`set -a; source .env; set +a`),
// see docs/deploy.md.
const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY?.trim();

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      },
      evmVersion: "berlin"
    },
    npmFilesToBuild: ["@openzeppelin/contracts/token/ERC20/IERC20.sol"]
  },
  networks: {
    default: {
      type: "edr-simulated",
      chainType: "l1"
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: deployerPrivateKey ? [deployerPrivateKey] : [],
      chainId: 11155111
    }
  },
  // The toolbox bundles @nomicfoundation/hardhat-verify; no new dependency
  // needed for Etherscan verification.
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY || ""
    }
  },
  typechain: {
    outDir: "typechain-types"
  },
  // Solidity tests live in Foundry (test/foundry, run by forge). Point Hardhat 3's
  // Solidity test runner elsewhere so `hardhat compile` skips them.
  paths: {
    tests: {
      solidity: "test/solidity"
    }
  }
});
