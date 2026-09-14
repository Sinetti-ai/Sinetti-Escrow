import { time } from "./_hardhat";

import { assertEqual, fundAndOpen, exampleCriteria, postBond, resolveContext, send } from "./_local";
import { attachedWindows, waitUntilTimestamp } from "./_network";

const STATE_REFUNDED = 6n;

async function main(): Promise<void> {
  const context = await resolveContext();
  const { amount, bond } = context.dealAmounts;
  const windows = context.attached
    ? await attachedWindows(context.escrow, { challengeWindow: 3600n, rulingWindow: 86400n })
    : undefined;

  const buyerBalanceBefore = await context.token.balanceOf(context.buyerAddress);
  const sellerBalanceBefore = await context.token.balanceOf(context.sellerAddress);
  const escrowBalanceBefore = await context.token.balanceOf(context.escrowAddress);

  const criteria = exampleCriteria();
  const dealId = await fundAndOpen(context, criteria, 300n, windows);
  await postBond(context, dealId);

  const deadline = (await context.escrow.getDeal(dealId)).deadline;
  if (context.attached) {
    console.log("\nNo local clock to fast-forward on a public network; waiting for real chain time");
    await waitUntilTimestamp(deadline + 1n, "the deal deadline to pass");
  } else {
    await time.increaseTo(deadline + 1n);
    console.log("\nHardhat advances past the deadline without wall-clock waiting");
  }
  await send(
    context,
    "Any account claims the timeout backstop",
    context.escrow.connect(context.deployer).claimTimeout(dealId)
  );
  await send(
    context,
    "Buyer withdraws refunded principal",
    context.escrow.connect(context.buyer)["withdraw(address)"](context.tokenAddress)
  );
  await send(
    context,
    "Seller withdraws returned bond",
    context.escrow.connect(context.seller)["withdraw(address)"](context.tokenAddress)
  );

  const deal = await context.escrow.getDeal(dealId);
  const buyerBalanceAfter = await context.token.balanceOf(context.buyerAddress);
  const sellerBalanceAfter = await context.token.balanceOf(context.sellerAddress);
  const escrowBalanceAfter = await context.token.balanceOf(context.escrowAddress);
  // Local mode mints amount/bond fresh after the "before" snapshot; attached mode's
  // accounts already held them pre-funded, so nothing changes net for either party.
  const expectedBuyerDelta = context.attached ? 0n : amount;
  const expectedSellerDelta = context.attached ? 0n : bond;
  assertEqual(deal.state, STATE_REFUNDED, "deal state");
  assertEqual(buyerBalanceAfter - buyerBalanceBefore, expectedBuyerDelta, "buyer balance change");
  assertEqual(sellerBalanceAfter - sellerBalanceBefore, expectedSellerDelta, "seller balance change");
  assertEqual(escrowBalanceAfter - escrowBalanceBefore, 0n, "escrow balance change");
  console.log(`\nSUCCESS: deal #${dealId} timed out; buyer principal and seller bond withdrawn.`);
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
