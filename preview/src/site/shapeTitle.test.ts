import assert from "node:assert/strict";
import test from "node:test";
import {compactShapeTitle, shapeTitle} from "./shapeTitle";

test("token zero uses its collection-owner identity", () => {
  assert.equal(shapeTitle(0n), "Shapes Collection Owner");
  assert.equal(compactShapeTitle(0n), "Collection Owner");
  assert.equal(shapeTitle(18n), "Shape 18");
  assert.equal(compactShapeTitle(18n), "#18");
});
