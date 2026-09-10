# Deploying to Sepolia

## Prerequisites

Node 22 and this repo's dependencies installed (`npm install`). A funded
Sepolia account and its private key. A settlement token already deployed on
Sepolia, or one you deploy yourself first (any ERC20 works; the escrow only
stores its address and checks that it has bytecode).

## Environment

Copy `.env.example` to `.env` and fill in the values described there. The
variables are not auto-loaded by hardhat.config.ts, so export them to the
shell before running a script:

```
set -a
source .env
set +a
```

Every policy input is required and explicit, with one exception:
`TOKEN_MAX_AMOUNT` and `TOKEN_MAX_BOND` default to the maximum uint256 value
when left unset, meaning an uncapped deployment rather than a silent zero.
`PARTICIPANT_ALLOWLIST` and `ARBITRATOR_ALLOWLIST` default to empty, meaning
open enrollment: any address can act as a participant, and any contract with
bytecode can arbitrate a deal.

## Running the deploy

```
npm run deploy:sepolia
```

This runs `scripts/deploy.ts` against the `sepolia` network defined in
`hardhat.config.ts`. It deploys `SinettiEscrowV04` first, then
`ConsoleArbitrator` pointed at the escrow's address, and refuses to proceed
if the deployer equals the pauser, the arbitrator's agent key equals its
officer, or the officer equals the pauser. The deployer may also serve as the
officer; the check only separates pause, proposal and override authority. A
single key controlling all three defeats the point of separating those roles,
so the script stops and prints which pairing collided rather than deploying.

The script writes `deployments/sepolia.json` with both contract addresses,
transaction hashes, block numbers, the constructor arguments used, the
current commit hash, and a `verification` block with the exact `cast`
commands to reproduce the on-chain checks. It never writes
`DEPLOYER_PRIVATE_KEY` or any other private key to disk. The `receipts` block
in that file is maintained by hand after public lifecycle runs; the script
rewrites the whole file, so carry the block over after a redeploy.

To try the flow without spending testnet ETH, run
`npm run deploy:local` instead, which points at Hardhat's in-process
network. The constructor only stores the token address and checks that it
has bytecode, so a local dry run needs a real deployed token; the repo's
`contracts/mocks/MockUSDC.sol` works for this.

## Verifying source on Etherscan

`hardhat.config.ts` already carries an `etherscan` block that reads
`ETHERSCAN_API_KEY`, because `@nomicfoundation/hardhat-toolbox` bundles the
Etherscan verify plugin; no extra dependency is needed for that path. This
repo also builds with Foundry, and Foundry's own verifier is the more direct
route since the contracts are compiled there too:

```
forge verify-contract <escrow-address> contracts/SinettiEscrowV04.sol:SinettiEscrowV04 \
  --chain sepolia --etherscan-api-key $ETHERSCAN_API_KEY

forge verify-contract <arbitrator-address> contracts/ConsoleArbitrator.sol:ConsoleArbitrator \
  --chain sepolia --etherscan-api-key $ETHERSCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,address,address,uint64)" <escrow-address> <agentKey> <officer> <overrideWindowSeconds>)
```

The deploy script prints both commands with the real addresses filled in at
the end of a successful run.

## Running the synthetic lifecycles against a deployed contract

`examples/full-lifecycle.ts`, `examples/dispute.ts`, and
`examples/timeout-refund.ts` can run two ways.

Leave `SINETTI_ESCROW_ADDRESS` unset and nothing changes. Each script still
deploys its own fresh `SinettiEscrowV04`, `TestEUR`, and
`MockManualArbitrator` on the in-process Hardhat network, funds four Hardhat
signer accounts from that network's own account list, and runs the lifecycle
against those throwaway contracts. This is what `npm run example`,
`example:dispute`, and `example:timeout` do.

Set `SINETTI_ESCROW_ADDRESS`, `SINETTI_ARBITRATOR_ADDRESS`, and
`SINETTI_TOKEN_ADDRESS`, for example to the values `deploy.ts` wrote into
`deployments/sepolia.json`, and the same scripts attach to that escrow
instead of deploying anything. Run them with `--network sepolia` (or whatever
network the addresses live on) so they talk to the right chain. Attached mode
needs its own signers, since there is no local Hardhat account list to draw
from. Set `BUYER_PRIVATE_KEY`, `SELLER_PRIVATE_KEY`, and
`VERIFIER_PRIVATE_KEY` to funded testnet keys, and for `examples/dispute.ts`
only, `ARBITRATOR_AGENT_PRIVATE_KEY`
matching the arbitrator the escrow was deployed with. None of these keys are
ever printed.

Attached mode never mints or funds anyone. Before opening a deal it checks
that the buyer and seller hold enough native currency for gas and enough of
the settlement token for their side of the deal, and it exits naming exactly
which account is short instead of failing partway through a transaction. It
also reads the deployed escrow's per-token caps, `maxAmountOf` and
`maxBondOf`, and bond floors, and clamps the deal amount, bond, and
challenger bond to fit under them, so a cap configured tighter than the
examples' usual figures still produces a valid deal instead of a revert.

There is no local clock to fast-forward on a public network. Where the local
version calls Hardhat's `time.increaseTo`, attached mode polls the chain's
own block timestamps and waits for real time to pass, printing how much
longer it expects to wait every 30 seconds. Set
`SINETTI_MAX_WAIT_SECONDS` to give up with a clear error instead of waiting
indefinitely. The dispute example's wait is the arbitrator's override
window. The deal it opens sets a ruling window long enough to clear that
override window plus the arbitrator's one-hour push buffer, matching what
`ConsoleArbitrator` itself requires before it will accept a ruling.

Every transaction each script sends prints its hash, so a run against a
public network leaves a trail that can be published as receipts.
