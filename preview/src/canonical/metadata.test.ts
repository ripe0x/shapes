import assert from "node:assert/strict";
import test from "node:test";
import {tokenMetadataJson} from "./render";
import {DENOMINATIONS} from "./denominations";

test("token zero has the collection-owner title and boolean trait", () => {
  const owner = JSON.parse(tokenMetadataJson(1n, DENOMINATIONS[0], 0n, 1n, false, 0, 0n));
  assert.equal(owner.name, "Shapes Collection Owner");
  assert.deepEqual(
    owner.attributes.find((trait: {trait_type: string}) => trait.trait_type === "Collection Owner"),
    {trait_type: "Collection Owner", value: "true"},
  );

  const ordinary = JSON.parse(tokenMetadataJson(1n, DENOMINATIONS[0], 1n, 1n, false, 0, 0n));
  assert.equal(ordinary.name, "Shape 1");
  assert.equal(
    ordinary.attributes.some((trait: {trait_type: string}) => trait.trait_type === "Collection Owner"),
    false,
  );
});
