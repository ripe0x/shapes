import assert from "node:assert/strict";
import test from "node:test";
import {ownerTokenNotices} from "./ownerTokenNotice";

test("no owner token means no notice, for any action", () => {
  for (const action of ["compose", "split", "decompose", "redeem", "burn"] as const) {
    assert.deepEqual(
      ownerTokenNotices({action, actingTokenId: 5n, ownerTokenId: null}),
      [],
    );
  }
});

test("compose: owner token as a donor moves ownership to the survivor", () => {
  assert.deepEqual(
    ownerTokenNotices({action: "compose", actingTokenId: 9n, donorIds: [3n, 7n], ownerTokenId: 7n}),
    [{text: "Collection ownership moves to Shape #9.", severity: "info"}],
  );
});

test("compose: owner token as the survivor is not a move", () => {
  assert.deepEqual(
    ownerTokenNotices({action: "compose", actingTokenId: 9n, donorIds: [3n, 7n], ownerTokenId: 9n}),
    [],
  );
});

test("compose: owner token unrelated to this compose gets no notice", () => {
  assert.deepEqual(
    ownerTokenNotices({action: "compose", actingTokenId: 9n, donorIds: [3n, 7n], ownerTokenId: 42n}),
    [],
  );
});

test("split: the owner token being split moves ownership to the first new Shape", () => {
  assert.deepEqual(
    ownerTokenNotices({action: "split", actingTokenId: 4n, ownerTokenId: 4n}),
    [{text: "Collection ownership moves to the first new Shape.", severity: "info"}],
  );
});

test("split: splitTo a different recipient also names who becomes owner", () => {
  assert.deepEqual(
    ownerTokenNotices({action: "split", actingTokenId: 4n, ownerTokenId: 4n, recipient: "0xABCD…1234"}),
    [
      {text: "Collection ownership moves to the first new Shape.", severity: "info"},
      {text: "0xABCD…1234 becomes the collection owner.", severity: "info"},
    ],
  );
});

test("split: a non-owner token being split gets no notice", () => {
  assert.deepEqual(
    ownerTokenNotices({action: "split", actingTokenId: 4n, ownerTokenId: 9n}),
    [],
  );
});

test("decompose: the undone compose carried ownership, so it moves back to that input", () => {
  assert.deepEqual(
    ownerTokenNotices({
      action: "decompose",
      actingTokenId: 6n,
      donorIds: [1n, 2n],
      ownerTokenId: 6n,
      restoredOwnerTokenId: 2n,
    }),
    [{text: "Collection ownership moves back to Shape #2.", severity: "info"}],
  );
});

test("decomposeTo: a different recipient becomes the collection owner", () => {
  assert.deepEqual(
    ownerTokenNotices({
      action: "decompose",
      actingTokenId: 6n,
      donorIds: [1n, 2n],
      recipient: "0xABCD…1234",
      ownerTokenId: 6n,
      restoredOwnerTokenId: 2n,
    }),
    [
      {text: "Collection ownership moves back to Shape #2.", severity: "info"},
      {text: "0xABCD…1234 becomes the collection owner.", severity: "info"},
    ],
  );
});

test("decompose: the undone compose never carried ownership, so it stays with the survivor", () => {
  assert.deepEqual(
    ownerTokenNotices({
      action: "decompose",
      actingTokenId: 6n,
      donorIds: [1n, 2n],
      ownerTokenId: 6n,
      restoredOwnerTokenId: null,
    }),
    [],
  );
});

test("decompose: a survivor that is not the owner token gets no notice", () => {
  assert.deepEqual(
    ownerTokenNotices({action: "decompose", actingTokenId: 6n, donorIds: [1n, 2n], ownerTokenId: 99n}),
    [],
  );
});

test("redeem: redeeming the owner token ends ownership permanently", () => {
  assert.deepEqual(
    ownerTokenNotices({action: "redeem", actingTokenId: 6n, ownerTokenId: 6n}),
    [{text: "This ends collection ownership permanently. No Shape inherits it.", severity: "warning"}],
  );
});

test("burn: burning the owner token ends ownership permanently", () => {
  assert.deepEqual(
    ownerTokenNotices({action: "burn", actingTokenId: 6n, ownerTokenId: 6n}),
    [{text: "This ends collection ownership permanently. No Shape inherits it.", severity: "warning"}],
  );
});

test("redeem: redeeming an ordinary Shape gets no ownership notice", () => {
  assert.deepEqual(
    ownerTokenNotices({action: "redeem", actingTokenId: 6n, ownerTokenId: 9n}),
    [],
  );
});
