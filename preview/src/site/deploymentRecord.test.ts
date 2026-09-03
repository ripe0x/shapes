import assert from "node:assert/strict";
import test from "node:test";
import {deploymentRecordName, ladderForChainId} from "./deploymentRecord";

test("deploymentRecordName defaults to the mainnet record when unset", () => {
  assert.equal(deploymentRecordName(undefined), "deployment");
  assert.equal(deploymentRecordName(""), "deployment");
});

test("deploymentRecordName passes through an explicit record name", () => {
  assert.equal(deploymentRecordName("deployment.sepolia"), "deployment.sepolia");
});

test("ladderForChainId picks testnet only for Sepolia", () => {
  assert.equal(ladderForChainId(11155111), "testnet");
  assert.equal(ladderForChainId(1), "mainnet");
  assert.equal(ladderForChainId(31337), "mainnet");
  assert.equal(ladderForChainId(undefined), "mainnet");
});
