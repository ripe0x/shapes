import assert from "node:assert/strict";
import test from "node:test";
import {compactShapeTitle, shapeTitle} from "./shapeTitle";

test("the owner-token id uses the collection-owner identity", () => {
  assert.equal(shapeTitle(0n, true), "Shapes Collection Owner");
  assert.equal(compactShapeTitle(0n, true), "Collection Owner");
  // Ownership can move off id 0 (compose/decompose/split); the same id with the flag false is
  // an ordinary Shape.
  assert.equal(shapeTitle(0n, false), "Shape 0");
  assert.equal(compactShapeTitle(0n, false), "#0");
});

test("any other live Shape can hold the owner-token flag", () => {
  assert.equal(shapeTitle(18n, true), "Shapes Collection Owner");
  assert.equal(compactShapeTitle(18n, true), "Collection Owner");
  assert.equal(shapeTitle(18n, false), "Shape 18");
  assert.equal(compactShapeTitle(18n, false), "#18");
});
