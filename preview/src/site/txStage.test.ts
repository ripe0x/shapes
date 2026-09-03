import {test} from "node:test";
import assert from "node:assert/strict";

import {TxStage, txStageLabel, txUrl} from "./ui";

// No jsdom/react-dom is wired into this suite (see wagmi.test.ts's plain node:test pattern), so
// TxStage is exercised as a plain function returning a React element tree, and the tree's props
// are asserted directly instead of rendering it to a DOM.

test("txStageLabel: idle op keeps the fallback label", () => {
  assert.equal(txStageLabel("redeem", "Redeem #1", null, null), "Redeem #1");
  assert.equal(txStageLabel("redeem", "Redeem #1", "split", null), "Redeem #1");
});

test("txStageLabel: busy with no hash yet reads 'Confirm in wallet'", () => {
  assert.equal(txStageLabel("redeem", "Redeem #1", "redeem", null), "Confirm in wallet");
  // A pendingTx left over from a different op does not count as this op's hash.
  assert.equal(
    txStageLabel("redeem", "Redeem #1", "redeem", {op: "split", hash: "0x1"}),
    "Confirm in wallet",
  );
});

test("txStageLabel: busy with a matching hash reads 'Pending'", () => {
  assert.equal(txStageLabel("redeem", "Redeem #1", "redeem", {op: "redeem", hash: "0x1"}), "Pending");
});

test("TxStage: renders nothing when idle", () => {
  assert.equal(TxStage({op: "redeem", busy: null, pendingTx: null, chainId: 1}), null);
  assert.equal(TxStage({op: "redeem", busy: "split", pendingTx: null, chainId: 1}), null);
});

test("TxStage: shows 'Confirm in wallet' before the wallet returns a hash", () => {
  const el = TxStage({op: "redeem", busy: "redeem", pendingTx: null, chainId: 1});
  assert.ok(el);
  assert.equal(el.props.children, "Confirm in wallet");
});

test("TxStage: shows the pending line and evm.now link once a hash lands", () => {
  const hash = "0xabc123" as const;
  const chainId = 11155111;
  const el = TxStage({op: "redeem", busy: "redeem", pendingTx: {op: "redeem", hash}, chainId});
  assert.ok(el);
  const parts: unknown[] = el.props.children.props.children;
  const link = parts[parts.length - 1] as {props: {href: string; children: string}};
  assert.match(parts[0] as string, /Transaction pending/);
  assert.equal(link.props.href, txUrl(hash, chainId));
  assert.equal(link.props.children, "View transaction");
});
