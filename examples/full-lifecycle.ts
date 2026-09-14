import { ethers, networkName } from "./_hardhat";

import { assertCommittedOnChain, describeDelivery, exampleDelivery } from "./_evidence";
import {
  assertEqual,
  exampleCriteria,
  fundAndOpen,
  postBond,
  resolveContext,
  send
} from "./_local";
import { attachedWindows } from "./_network";

const STATE_RELEASED = 5n;

async function main(): Promise<void> {
  const context = await resolveContext();
  const { amount, bond } = context.dealAmounts;
  const windows = context.attached
    ? await attachedWindows(context.escrow, { challengeWindow: 3600n, rulingWindow: 86400n })
    : undefined;

  const criteria = exampleCriteria();
  const delivery = exampleDelivery();
  console.log("Seller hashes the delivery in examples/delivery/");
  console.log(describeDelivery(delivery));

  const sellerBalanceBefore = await context.token.balanceOf(context.sellerAddress);
  const escrowBalanceBefore = await context.token.balanceOf(context.escrowAddress);

  const dealId = await fundAndOpen(context, criteria, 3600n, windows);
  await postBond(context, dealId);

  await send(
    context,
    "Seller submits delivery evidence",
    context.escrow.connect(context.seller).submitDelivery(
      dealId,
      delivery.evidenceHash
    )
  );
  console.log(
    `  read back from chain: ${await assertCommittedOnChain(context.escrow, dealId)}`
  );
  await send(
    context,
    "Verifier records Pass; buyer challenge window opens",
    context.escrow.connect(context.verifier).recordVerification(dealId, 1)
  );
  await send(
    context,
    "Buyer accepts Pass; escrow credits seller",
    context.escrow.connect(context.buyer).accept(dealId)
  );
  await send(
    context,
    "Seller withdraws released principal and returned bond",
    context.escrow.connect(context.seller)["withdraw(address)"](context.tokenAddress)
  );

  const deal = await context.escrow.getDeal(dealId);
  const sellerBalanceAfter = await context.token.balanceOf(context.sellerAddress);
  const escrowBalanceAfter = await context.token.balanceOf(context.escrowAddress);
  // Local mode mints amount/bond fresh after the "before" snapshot, so the seller's
  // delta includes both. Attached mode's seller already held the bond pre-funded
  // before the snapshot, so only the settled amount is new.
  const expectedSellerDelta = context.attached ? amount : amount + bond;
  assertEqual(deal.state, STATE_RELEASED, "deal state");
  assertEqual(sellerBalanceAfter - sellerBalanceBefore, expectedSellerDelta, "seller balance change");
  assertEqual(escrowBalanceAfter - escrowBalanceBefore, 0n, "escrow balance change");

  const unit = context.attached ? "token base units" : "tEUR";
  const displayAmount = context.attached ? amount.toString() : ethers.formatUnits(amount, 6);
  console.log(`\nSUCCESS: deal #${dealId} paid ${displayAmount} ${unit} to seller after withdrawal; bond withdrawn.`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
