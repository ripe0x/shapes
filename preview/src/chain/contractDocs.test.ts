import assert from "node:assert/strict";
import test from "node:test";
import {contractDocFromArtifact, oneParagraph, typeOf, type Artifact} from "./contractDocs";
import {CONTRACT_DOCS} from "./contractDocs.generated";

/** A hand-built artifact in the shape Foundry writes: ABI, rawMetadata as a JSON string, and the
 *  library-only storage-pointer surface in methodIdentifiers. */
const FIXTURE: Artifact = {
  abi: [
    {
      type: "function",
      name: "compose",
      inputs: [
        {name: "survivorId", type: "uint256", internalType: "uint256"},
        {name: "burnIds", type: "uint256[]", internalType: "uint256[]"},
      ],
      outputs: [{name: "", type: "uint256", internalType: "uint256"}],
      stateMutability: "nonpayable",
    },
    {
      type: "function",
      name: "batch",
      inputs: [
        {
          name: "calls",
          type: "tuple[]",
          internalType: "struct Call[]",
          components: [
            {name: "id", type: "uint256", internalType: "uint256"},
            {name: "ids", type: "uint256[]", internalType: "uint256[]"},
          ],
        },
      ],
      outputs: [],
      stateMutability: "payable",
    },
    {
      type: "event",
      name: "Composed",
      inputs: [
        {name: "survivorId", type: "uint256", indexed: true, internalType: "uint256"},
        {name: "burnedIds", type: "uint256[]", indexed: false, internalType: "uint256[]"},
      ],
      anonymous: false,
    },
    {type: "error", name: "TokenIsBlack", inputs: [{name: "tokenId", type: "uint256", internalType: "uint256"}]},
    // Reachable through two library paths, so the ABI lists it twice; only the second is
    // positioned where NatSpec attaches, and neither may reach the page as a duplicate.
    {type: "error", name: "DenominationIndexOutOfRange", inputs: [{name: "index", type: "uint256", internalType: "uint256"}]},
    {type: "error", name: "DenominationIndexOutOfRange", inputs: [{name: "index", type: "uint256", internalType: "uint256"}]},
  ],
  methodIdentifiers: {
    "compose(uint256,uint256[])": "aaaaaaaa",
    "setMintFee(AdminOps.FeeConfig storage,uint256)": "bbbbbbbb",
  },
  rawMetadata: JSON.stringify({
    output: {
      devdoc: {
        title: "Fixture",
        details: "A dev\n     paragraph.",
        methods: {
          "compose(uint256,uint256[])": {
            details: "Moves no ETH.",
            params: {burnIds: "The Shapes\n     to burn.", survivorId: "The Shape that survives."},
            returns: {_0: "The survivor's id."},
          },
          "setMintFee(AdminOps.FeeConfig storage,uint256)": {details: "Body of `Shapes.setMintFee`."},
        },
        events: {"Composed(uint256,uint256[])": {details: "Emitted from Shapes."}},
      },
      userdoc: {
        notice: "A fixture contract.",
        methods: {"compose(uint256,uint256[])": {notice: "Compose several Shapes into one."}},
        events: {"Composed(uint256,uint256[])": {notice: "Several Shapes became one."}},
        errors: {
          "TokenIsBlack(uint256)": [{notice: "That Shape is Black."}],
          "DenominationIndexOutOfRange(uint256)": {notice: "That denomination does not exist."},
        },
      },
    },
  }),
};

test("typeOf expands tuples and tuple arrays to their canonical component list", () => {
  assert.equal(
    typeOf({
      name: "calls",
      type: "tuple[]",
      components: [
        {name: "id", type: "uint256"},
        {name: "ids", type: "uint256[]"},
      ],
    }),
    "(uint256,uint256[])[]",
  );
});

test("oneParagraph collapses NatSpec's wrapped continuation lines", () => {
  assert.equal(oneParagraph("A dev\n     paragraph."), "A dev paragraph.");
  assert.equal(oneParagraph(undefined), "");
});

test("the transform takes the description from @notice and the contract dev text from @dev", () => {
  const doc = contractDocFromArtifact("Fixture", "token", FIXTURE);
  assert.equal(doc.name, "Fixture");
  assert.equal(doc.kind, "token");
  assert.equal(doc.description, "A fixture contract.");
  assert.equal(doc.dev, "A dev paragraph.");
});

test("functions carry the ABI entry, canonical signature and both NatSpec texts, sorted", () => {
  const doc = contractDocFromArtifact("Fixture", "token", FIXTURE);
  assert.deepEqual(
    doc.functions.map((f) => f.signature),
    ["batch((uint256,uint256[])[])", "compose(uint256,uint256[])", "setMintFee(AdminOps.FeeConfig storage,uint256)"],
  );
  const compose = doc.functions[1];
  assert.equal(compose.notice, "Compose several Shapes into one.");
  assert.equal(compose.dev, "Moves no ETH.");
  assert.equal(compose.stateMutability, "nonpayable");
  assert.deepEqual(compose.inputs, [
    {name: "survivorId", type: "uint256"},
    {name: "burnIds", type: "uint256[]"},
  ]);
  assert.deepEqual(compose.outputs, [{name: "", type: "uint256"}]);
  // @param and @return text is carried per name, collapsed and key-sorted.
  assert.deepEqual(compose.params, {burnIds: "The Shapes to burn.", survivorId: "The Shape that survives."});
  assert.deepEqual(compose.returns, {_0: "The survivor's id."});
  assert.deepEqual(doc.functions[0].params, {});
  // internalType is dropped; the entry is otherwise callable as-is.
  assert.deepEqual(compose.abi, {
    type: "function",
    name: "compose",
    inputs: [
      {name: "survivorId", type: "uint256"},
      {name: "burnIds", type: "uint256[]"},
    ],
    outputs: [{name: "", type: "uint256"}],
    stateMutability: "nonpayable",
  });
  assert.equal(doc.functions[0].inputs[0].type, "(uint256,uint256[])[]");
});

test("a library's storage-pointer function is documentation only: no ABI entry, no parameters", () => {
  const doc = contractDocFromArtifact("Fixture", "library", FIXTURE);
  const setMintFee = doc.functions.find((f) => f.name === "setMintFee");
  assert.ok(setMintFee);
  assert.equal(setMintFee.abi, undefined);
  assert.equal(setMintFee.stateMutability, "");
  assert.deepEqual(setMintFee.inputs, []);
  assert.equal(setMintFee.dev, "Body of `Shapes.setMintFee`.");
});

test("events keep their indexed flags and errors read the array form of userdoc", () => {
  const doc = contractDocFromArtifact("Fixture", "token", FIXTURE);
  assert.deepEqual(doc.events, [
    {
      name: "Composed",
      signature: "Composed(uint256,uint256[])",
      inputs: [
        {name: "survivorId", type: "uint256", indexed: true},
        {name: "burnedIds", type: "uint256[]", indexed: false},
      ],
      notice: "Several Shapes became one.",
      dev: "Emitted from Shapes.",
    },
  ]);
  assert.equal(doc.errors.find((e) => e.name === "TokenIsBlack")?.notice, "That Shape is Black.");
});

test("a member declared through two paths is listed once, keeping the documented entry", () => {
  const doc = contractDocFromArtifact("Fixture", "token", FIXTURE);
  const duplicates = doc.errors.filter((e) => e.name === "DenominationIndexOutOfRange");
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].notice, "That denomination does not exist.");
  // An undocumented duplicate still collapses to one entry, keeping the first occurrence.
  const bare = contractDocFromArtifact("Bare", "token", {abi: FIXTURE.abi});
  assert.equal(bare.errors.filter((e) => e.name === "DenominationIndexOutOfRange").length, 1);
  for (const contract of [doc, bare]) {
    for (const list of [contract.functions, contract.events, contract.errors]) {
      const signatures = list.map((m) => m.signature);
      assert.equal(new Set(signatures).size, signatures.length);
    }
  }
});

test("a metadata object rather than a JSON string still parses", () => {
  const doc = contractDocFromArtifact("Fixture", "token", {
    abi: FIXTURE.abi,
    metadata: JSON.parse(FIXTURE.rawMetadata as string) as unknown,
  });
  assert.equal(doc.description, "A fixture contract.");
});

test("a missing or unparseable metadata field degrades to the ABI alone", () => {
  const doc = contractDocFromArtifact("Bare", "library", {abi: FIXTURE.abi, rawMetadata: "{not json"});
  assert.equal(doc.description, "Bare");
  assert.equal(doc.dev, "");
  assert.equal(doc.functions.length, 2);
});

// The committed generated file is checked against out/ by `npm run contracts:docs:check`, which
// needs forge. This asserts the shape the page depends on without one.
test("the committed contract docs cover the whole deployment, in page order", () => {
  assert.deepEqual(
    CONTRACT_DOCS.map((c) => [c.name, c.kind]),
    [
      ["Shapes", "token"],
      ["ShapeRenderer", "renderer"],
      ["ShapeCollection", "collection"],
      ["ShapeAuctionHouse", "application"],
      ["RecompositionOps", "library"],
      ["AdminOps", "library"],
      ["ComposeCompute", "library"],
      ["GeometrySampling", "library"],
      ["InkGenes", "library"],
    ],
  );
  for (const contract of CONTRACT_DOCS) {
    assert.ok(contract.description.length > 0, `${contract.name} has no description`);
    assert.ok(contract.functions.length > 0, `${contract.name} has no functions`);
    const signatures = contract.functions.map((f) => f.signature);
    assert.deepEqual(signatures, [...signatures].sort(), `${contract.name} functions are unsorted`);
    for (const list of [contract.functions, contract.events, contract.errors]) {
      const all = list.map((m) => m.signature);
      assert.equal(new Set(all).size, all.length, `${contract.name} lists a signature twice`);
    }
  }
  const shapes = CONTRACT_DOCS[0];
  assert.ok(shapes.functions.find((f) => f.signature === "compose(uint256,uint256[])")?.abi);
  assert.ok(shapes.errors.some((e) => e.name === "NoOwnerToken"));
  assert.ok(shapes.events.some((e) => e.name === "ShapeMinted"));
});
