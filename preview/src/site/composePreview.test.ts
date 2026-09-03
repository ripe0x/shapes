import {test} from "node:test";
import assert from "node:assert/strict";

import {effectiveModuleBytes} from "../canonical/sampling";
import {moduleBytesToHex} from "../canonical/moduleCodec";
import {DENOMINATIONS} from "../chain/abi";
import {buildComposeResultPreview, effectiveRecordModules} from "./composePreview";

test("buildComposeResultPreview renders the exact materialized card under the surviving token id", () => {
  const modules = effectiveModuleBytes({seed: 0x1234n, denomIndex: 1, inkGene: 2});
  const preview = buildComposeResultPreview(
    {
      denominationIndex: 1,
      inkGene: 2,
      faceValueWei: DENOMINATIONS[1].wei,
      modules: moduleBytesToHex(modules),
    },
    17n,
  );

  assert.equal(preview.tokenId, 17n);
  assert.equal(preview.denominationIndex, 1);
  assert.equal(preview.faceValueWei, DENOMINATIONS[1].wei);
  assert.match(preview.image, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(preview.image.split(",")[1]!, "base64").toString(), /^<svg /);
});

test("buildComposeResultPreview rejects an empty materialized result", () => {
  assert.throws(() =>
    buildComposeResultPreview(
      {denominationIndex: 1, inkGene: 2, faceValueWei: DENOMINATIONS[1].wei, modules: "0x"},
      17n,
    ),
  );
});

test("effectiveRecordModules falls back to grammar v1 for a seed-drawn compose input", () => {
  // A compose record's `modules` is empty when the input it snapshots had none of its own
  // (ShapeTypes.sol: "empty when it had none") — the case a Shape composed from freshly minted,
  // never-materialized inputs hits on every decompose.
  const modules = effectiveRecordModules({seed: 0x1234n, denominationIndex: 1, inkGene: 2, modules: "0x"});
  assert.notEqual(modules, "0x");

  const preview = buildComposeResultPreview(
    {denominationIndex: 1, inkGene: 2, faceValueWei: DENOMINATIONS[1].wei, modules},
    17n,
  );
  assert.match(preview.image, /^data:image\/svg\+xml;base64,/);
  assert.match(Buffer.from(preview.image.split(",")[1]!, "base64").toString(), /^<svg /);
});

test("effectiveRecordModules keeps a materialized record's own bytes", () => {
  const materialized = effectiveModuleBytes({seed: 0xaaan, denomIndex: 1, inkGene: 3});
  const modules = effectiveRecordModules({
    seed: 0xaaan,
    denominationIndex: 1,
    inkGene: 3,
    modules: moduleBytesToHex(materialized),
  });
  assert.equal(modules, moduleBytesToHex(materialized));
});
