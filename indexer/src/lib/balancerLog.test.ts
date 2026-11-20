import assert from "node:assert/strict";
import {test} from "node:test";
import {checkpointBlock, jsonArgs} from "./balancerLog.ts";
// Ponder's internal encoder, by file path since the package exports do not include it.
// @ts-expect-error untyped internal module
import {encodeCheckpoint} from "../../node_modules/ponder/dist/esm/utils/checkpoint.js";

test("uints become decimal strings, addresses lowercase, small ints and bools stay", () => {
  assert.deepEqual(
    jsonArgs({
      listingId: 2n ** 255n,
      kind: 2,
      delivered: false,
      collection: "0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0",
      salt: "0x00000000000000000000000000000000000000000000000000000000000000AB",
    }),
    {
      listingId: (2n ** 255n).toString(),
      kind: 2,
      delivered: false,
      collection: "0x6fe9193276bf7abcbee44ab7afd717d637d6faf0",
      salt: "0x00000000000000000000000000000000000000000000000000000000000000AB",
    },
  );
  assert.equal(JSON.stringify(jsonArgs({amount: 10n ** 18n})), '{"amount":"1000000000000000000"}');
});

test("an arg JSON cannot carry is refused, not dropped", () => {
  assert.throws(() => jsonArgs({ids: [1n]}), /unsupported event arg ids/);
});

test("checkpoint block matches Ponder's own encoding", () => {
  const checkpoint = encodeCheckpoint({
    blockTimestamp: 1763650000n, chainId: 1n, blockNumber: 26453686n, transactionIndex: 7n, eventType: 5, eventIndex: 12n,
  });
  assert.equal(checkpointBlock(checkpoint), 26453686);
  assert.throws(() => checkpointBlock("123"), /unexpected checkpoint/);
});
