import {test} from "node:test";
import assert from "node:assert/strict";

import {isProvenanceRollup, provenanceRollupLabel} from "./provenance";

test("provenance rollup placeholders are labels, not denomination-zero token cards", () => {
  const rollup = {more: 12};
  assert.equal(isProvenanceRollup(rollup), true);
  assert.equal(provenanceRollupLabel(rollup), "+12 more");
  assert.equal(isProvenanceRollup({}), false);
});
