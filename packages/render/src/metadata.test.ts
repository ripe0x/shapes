import assert from "node:assert/strict";
import test from "node:test";
import {tokenMetadataJson} from "./render";
import {DENOMINATIONS, LABELS} from "./denominations";

test("names lead with the ETH value; token zero has the contract-owner title and value-only attribute", () => {
  const owner = JSON.parse(tokenMetadataJson(1n, DENOMINATIONS[0], 0n, 1n, false, 0, 0n));
  assert.equal(owner.name, `${LABELS[0]} ETH · Shape #0, Contract Owner`);
  assert.deepEqual(
    owner.attributes.find((trait: {value: string}) => trait.value === "Contract Owner"),
    {value: "Contract Owner"},
  );

  const ordinary = JSON.parse(tokenMetadataJson(1n, DENOMINATIONS[0], 1n, 1n, false, 0, 0n));
  assert.equal(ordinary.name, `${LABELS[0]} ETH · Shape #1`);
  assert.equal(
    ordinary.attributes.some((trait: {value: string}) => trait.value === "Contract Owner"),
    false,
  );
});
