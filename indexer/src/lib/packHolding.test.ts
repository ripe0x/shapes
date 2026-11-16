import assert from "node:assert/strict";
import {test} from "node:test";
import {afterPackClaim} from "./packHolding.ts";

const claimant = "0x1234567890123456789012345678901234567890" as const;

test("a partial claim retains the right and the last claim clears it", () => {
  const partial = afterPackClaim(7n, claimant, 3n, 2);
  assert.deepEqual(partial, {claimant, remainingCount: 1n});
  assert.deepEqual(afterPackClaim(7n, partial.claimant!, partial.remainingCount, 1), {
    claimant: null,
    remainingCount: 0n,
  });
});

test("a zero or oversized claim cannot corrupt indexed rights", () => {
  assert.throws(() => afterPackClaim(7n, claimant, 3n, 0), /claim count exceeds/);
  assert.throws(() => afterPackClaim(7n, claimant, 3n, 4), /claim count exceeds/);
});
