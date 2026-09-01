import {test} from "node:test";
import assert from "node:assert/strict";
import {displayTraits} from "./displayTraits";

const fullMetadata = [
  {trait_type: "ETH Value", value: "0.001 ETH"},
  {trait_type: "Grid", value: "4x4"},
  {trait_type: "Fill", value: "Mixed"},
  {trait_type: "Ink", value: "Murk"},
  {trait_type: "Modules", value: "□ ◇ ◁ ◒"},
  {trait_type: "Module Count", value: "16"},
  {trait_type: "Primitive", value: "Half Circle"},
  {trait_type: "Variety", value: "8"},
  {trait_type: "Ink Tier", value: "Common"},
  {trait_type: "Formation", value: "Complete"},
  {trait_type: "Independent Origins", value: "10"},
  {trait_type: "Origin Density", value: "100%"},
  {trait_type: "Complete", value: "true"},
  {trait_type: "Black", value: "false"},
  {trait_type: "Compose Depth", value: "2"},
];

test("displayTraits keeps useful independent facts and translates protocol metadata", () => {
  const rows = displayTraits(fullMetadata);

  assert.deepEqual(
    rows.map(({label, value}) => [label, value]),
    [
      ["grid", "4x4"],
      ["fill", "Mixed"],
      ["ink", "Murk"],
      ["dominant module", "Half Circle"],
      ["module types", "8 of 10"],
      ["mint origins", "10"],
      ["origin coverage", "100%"],
      ["reversible composes", "2"],
    ],
  );
  assert.match(rows.find((row) => row.label === "ink")?.description ?? "", /50%/);
  assert.equal(rows.some((row) => row.label === "formation"), false);
});

test("displayTraits omits zero compose depth and explains split lineage when present", () => {
  const rows = displayTraits([
    {trait_type: "Compose Depth", value: "0"},
    {trait_type: "Split From", value: "0.05 ETH"},
    {trait_type: "Split Origin", value: "1 ETH"},
  ]);

  assert.deepEqual(
    rows.map(({label, value}) => [label, value]),
    [
      ["split parent", "0.05 ETH"],
      ["split root", "1 ETH"],
    ],
  );
});
