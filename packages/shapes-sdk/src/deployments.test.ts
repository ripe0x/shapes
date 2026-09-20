import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentFor, shapesAbi, shapeAuctionHouseAbi, supportedChainIds } from "./deployments.ts";

test("mainnet and Sepolia both resolve to a deployment record with a live Shapes address", () => {
  const mainnet = deploymentFor(1);
  assert.equal(mainnet.chainId, 1);
  assert.match(mainnet.shapes, /^0x[0-9a-f]{40}$/);

  const sepolia = deploymentFor(11155111);
  assert.equal(sepolia.chainId, 11155111);
  assert.match(sepolia.shapes, /^0x[0-9a-f]{40}$/);
});

test("supportedChainIds names both records", () => {
  assert.deepEqual([...supportedChainIds()].sort((a, b) => a - b), [1, 11155111]);
});

test("an unrecorded chain throws rather than returning a wrong-chain default", () => {
  assert.throws(() => deploymentFor(999), /no deployment record for chain 999/);
});

test("the vendored ABIs are non-empty and carry the core entrypoints", () => {
  assert.ok(shapesAbi.length > 0);
  assert.ok(shapeAuctionHouseAbi.length > 0);
  assert.ok(shapesAbi.some((entry) => "name" in entry && entry.name === "tokenURI"));
});
