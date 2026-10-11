import {test} from "node:test";
import assert from "node:assert/strict";
import {TransactionRejectedRpcError} from "viem";

import {describeTxError} from "./errors";

test("OutOfFunds behind a generic RPC rejection explains the ETH shortfall", () => {
  const error = new TransactionRejectedRpcError(new Error("EVM error: OutOfFunds"));
  assert.equal(describeTxError(error),
    "This wallet does not have enough ETH for the payment and network gas.");
});

test("other transaction creation failures keep their original message", () => {
  const error = new TransactionRejectedRpcError(new Error("Wallet failed to create transaction"));
  assert.equal(describeTxError(error), "Transaction creation failed.");
});
