import assert from "node:assert/strict";
import test from "node:test";
import {DENOMINATIONS} from "../chain/abi";
import type {SiteToken} from "./data";
import {
  composeBurnIds,
  composeRung,
  isCompleteRungSelection,
} from "./composeSelection";

const OWNER: `0x${string}` = "0x1111111111111111111111111111111111111111";
const OTHER: `0x${string}` = "0x2222222222222222222222222222222222222222";

function token(id: bigint, di: number, owner = OWNER): SiteToken {
  return {
    id,
    owner,
    di,
    backing: di < 0 ? 0n : DENOMINATIONS[di].wei,
    seed: 0n,
    inkGene: 0,
    composeDepth: 0,
    image: "",
    meta: {name: `Shape ${id}`, description: "", attributes: []},
  };
}

test("composeRung follows every measured equal-denomination ladder step", () => {
  for (let sourceIndex = 0; sourceIndex < DENOMINATIONS.length - 1; sourceIndex++) {
    const rung = composeRung(sourceIndex)!;
    assert.equal(rung.targetIndex, sourceIndex + 1);
    assert.equal(
      rung.totalShapes,
      Number(DENOMINATIONS[sourceIndex + 1].wei / DENOMINATIONS[sourceIndex].wei),
    );
    assert.ok(rung.totalShapes === 2 || rung.totalShapes === 5);
  }
  assert.equal(composeRung(-1), null);
  assert.equal(composeRung(DENOMINATIONS.length - 1), null);
});

test("a complete rung requires exact count, denomination, ownership and distinct live ids", () => {
  const inventory = [token(1n, 0), token(2n, 0), token(3n, 0), token(4n, 0), token(5n, 0)];
  assert.equal(isCompleteRungSelection(inventory, OWNER, [1n, 2n, 3n, 4n, 5n]), true);
  assert.equal(isCompleteRungSelection(inventory, OWNER, [1n, 2n, 3n, 4n]), false);
  assert.equal(isCompleteRungSelection(inventory, OWNER, [1n, 2n, 3n, 4n, 4n]), false);
  assert.equal(isCompleteRungSelection([...inventory, token(6n, 1)], OWNER, [1n, 2n, 3n, 4n, 6n]), false);
  assert.equal(isCompleteRungSelection([...inventory, token(6n, -1)], OWNER, [1n, 2n, 3n, 4n, 6n]), false);
  assert.equal(isCompleteRungSelection([...inventory.slice(0, 4), token(5n, 0, OTHER)], OWNER, [1n, 2n, 3n, 4n, 5n]), false);
});

test("composeBurnIds excludes the explicit survivor and sorts the absorbed ids", () => {
  assert.deepEqual(composeBurnIds([9n, 2n, 7n, 4n, 1n], 7n), [1n, 2n, 4n, 9n]);
});
