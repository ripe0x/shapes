import assert from "node:assert/strict";
import { test } from "node:test";

import { activityId, activityOrderKey, activityRow, mintActivityId } from "./activity.ts";

const TX = "0xaa".padEnd(66, "0") as `0x${string}`;
const ALICE = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const BOB = "0x2222222222222222222222222222222222222222" as `0x${string}`;

const at = (blockNumber: bigint, logIndex: number) => ({
  txHash: TX,
  logIndex,
  blockNumber,
  timestamp: 1_700_000_000n,
});

test("orderKey sorts by block first and by log index within a block", () => {
  const keys = [
    activityOrderKey(10n, 7),
    activityOrderKey(10n, 2),
    activityOrderKey(9n, 4_000_000_000),
    activityOrderKey(11n, 0),
  ];
  const descending = [...keys].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));

  assert.deepEqual(descending, [
    activityOrderKey(11n, 0),
    activityOrderKey(10n, 7),
    activityOrderKey(10n, 2),
    activityOrderKey(9n, 4_000_000_000),
  ]);
});

test("mint rows key on the transaction so a batch folds into one row", () => {
  const row = {
    ...activityRow(at(12n, 3), "mint", [1n], ALICE, { amountWei: 10n ** 16n }),
    id: mintActivityId(TX),
  };

  assert.equal(row.id, `${TX}-mint`);
  assert.notEqual(row.id, activityId(TX, 3));
  assert.equal(row.kind, "mint");
  assert.deepEqual(row.tokenIds, [1n]);
  assert.equal(row.actor, ALICE);
  assert.equal(row.amountWei, 10n ** 16n);
  // Every detail the kind does not carry stays null.
  assert.equal(row.counterparty, null);
  assert.equal(row.auctionId, null);
  assert.equal(row.units, null);
});

test("compose rows lead with the survivor and key on the log", () => {
  const row = activityRow(at(20n, 5), "compose", [7n, 8n, 9n], BOB);

  assert.equal(row.id, `${TX}-5`);
  assert.equal(row.orderKey, activityOrderKey(20n, 5));
  assert.deepEqual(row.tokenIds, [7n, 8n, 9n]);
  assert.equal(row.actor, BOB);
  assert.equal(row.amountWei, null);
});
