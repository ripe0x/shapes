import {test} from "node:test";
import assert from "node:assert/strict";
import {ContractFunctionRevertedError, encodeErrorResult, type PublicClient} from "viem";

import {shapesAbi} from "../chain/abi";
import {awaitSuccessfulReceipt, bufferGas} from "./tx";

const SHAPES = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;
const FROM = "0x1111111111111111111111111111111111111111" as `0x${string}`;
const HASH = `0x${"11".repeat(32)}` as `0x${string}`;

test("bufferGas adds 50% headroom", () => {
  assert.equal(bufferGas(100_000n), 150_000n);
});

test("awaitSuccessfulReceipt returns the receipt when the transaction succeeded", async () => {
  const receipt = {status: "success", blockNumber: 5n} as const;
  const publicClient = {
    waitForTransactionReceipt: async () => receipt,
    getTransaction: async () => {
      throw new Error("should not replay a successful transaction");
    },
    simulateContract: async () => {
      throw new Error("should not replay a successful transaction");
    },
  } as unknown as PublicClient;

  const result = await awaitSuccessfulReceipt(publicClient, HASH, {
    address: SHAPES,
    abi: shapesAbi,
    functionName: "redeem",
    args: [1n],
  });
  assert.equal(result, receipt);
});

test("awaitSuccessfulReceipt throws the decoded reason for a reverted transaction", async () => {
  const data = encodeErrorResult({abi: shapesAbi, errorName: "NotShapeOwner"});
  const revert = new ContractFunctionRevertedError({abi: shapesAbi, data, functionName: "redeem"});
  const publicClient = {
    waitForTransactionReceipt: async () => ({status: "reverted", blockNumber: 5n}),
    getTransaction: async () => ({from: FROM}),
    simulateContract: async () => {
      throw revert;
    },
  } as unknown as PublicClient;

  await assert.rejects(
    () =>
      awaitSuccessfulReceipt(publicClient, HASH, {
        address: SHAPES,
        abi: shapesAbi,
        functionName: "redeem",
        args: [1n],
      }),
    (error: unknown) => error === revert,
  );
});

test("awaitSuccessfulReceipt reports a plain failure when the replay does not reproduce a reason", async () => {
  const publicClient = {
    waitForTransactionReceipt: async () => ({status: "reverted", blockNumber: 5n}),
    getTransaction: async () => ({from: FROM}),
    simulateContract: async () => undefined,
  } as unknown as PublicClient;

  await assert.rejects(
    () =>
      awaitSuccessfulReceipt(publicClient, HASH, {
        address: SHAPES,
        abi: shapesAbi,
        functionName: "redeem",
        args: [1n],
      }),
    /Transaction reverted/,
  );
});
