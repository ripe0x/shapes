import assert from "node:assert/strict";
import test from "node:test";
import {parseArg, parseArgs, parseEthValue} from "./contractArgs";

const ok = (type: string, raw: string) => {
  const result = parseArg(type, raw);
  assert.ok(result.ok, `expected ${type} "${raw}" to parse, got ${result.ok ? "" : result.error}`);
  return result.value;
};

const err = (type: string, raw: string) => {
  const result = parseArg(type, raw);
  assert.ok(!result.ok, `expected ${type} "${raw}" to fail`);
  return result.error;
};

test("integers accept decimal and hex and become bigints", () => {
  assert.equal(ok("uint256", "123"), 123n);
  assert.equal(ok("uint256", " 0xff "), 255n);
  assert.equal(ok("uint8", "0"), 0n);
  assert.equal(ok("int256", "-5"), -5n);
});

test("a non-numeric integer is a message, not a throw", () => {
  assert.match(err("uint256", "12.5"), /not a uint256/);
  assert.match(err("uint256", "abc"), /not a uint256/);
  assert.equal(err("uint256", ""), "Required");
});

test("addresses need 0x and forty hex characters, in either case", () => {
  assert.equal(ok("address", "0x00000000219ab540356cBB839Cbe05303d7705Fa"), "0x00000000219ab540356cBB839Cbe05303d7705Fa");
  assert.match(err("address", "0x1234"), /40 hex characters/);
  assert.match(err("address", "vitalik.eth"), /40 hex characters/);
});

test("bool reads true and false, and nothing else", () => {
  assert.equal(ok("bool", "true"), true);
  assert.equal(ok("bool", "FALSE"), false);
  assert.match(err("bool", "1"), /true or false/);
});

test("bytes must be even-length hex, and a fixed size must be exact", () => {
  assert.equal(ok("bytes", "0x"), "0x");
  assert.equal(ok("bytes", "0xdeadbeef"), "0xdeadbeef");
  assert.equal(ok("bytes32", `0x${"11".repeat(32)}`), `0x${"11".repeat(32)}`);
  assert.match(err("bytes", "deadbeef"), /must be 0x/);
  assert.match(err("bytes", "0xabc"), /even number/);
  assert.match(err("bytes32", "0xdeadbeef"), /exactly 32 bytes/);
});

test("string is taken verbatim, quoting and all", () => {
  assert.equal(ok("string", ' a "quoted" name '), ' a "quoted" name ');
  assert.equal(ok("string", ""), "");
});

test("arrays are JSON and their elements are coerced by element type", () => {
  assert.deepEqual(ok("uint256[]", "[1, 2, 3]"), [1n, 2n, 3n]);
  assert.deepEqual(ok("uint8[]", "[]"), []);
  assert.deepEqual(ok("uint256[]", '["0x10", 2]'), [16n, 2n]);
  assert.deepEqual(ok("string[]", '["a", "b"]'), ["a", "b"]);
  assert.deepEqual(ok("uint256[2]", "[1, 2]"), [1n, 2n]);
  assert.match(err("uint256[2]", "[1]"), /exactly 2 items/);
  assert.match(err("uint256[]", "1, 2"), /valid JSON/);
  assert.match(err("uint256[]", '["a"]'), /not a uint256/);
});

test("tuples are JSON arrays, positional, and nest", () => {
  assert.deepEqual(ok("(uint256,uint256[])", "[7, [1, 2]]"), [7n, [1n, 2n]]);
  assert.deepEqual(ok("(uint256,uint256[])[]", "[[7, [1]], [8, []]]"), [
    [7n, [1n]],
    [8n, []],
  ]);
  assert.match(err("(uint256,address)", "[1]"), /exactly 2 fields/);
  assert.match(err("(uint256,address)", "{}"), /JSON array/);
});

test("parseArgs reports the first bad field by index", () => {
  const inputs = [
    {name: "tokenId", type: "uint256"},
    {name: "to", type: "address"},
  ];
  assert.deepEqual(parseArgs(inputs, ["1", "0x00000000219ab540356cBB839Cbe05303d7705Fa"]), {
    ok: true,
    values: [1n, "0x00000000219ab540356cBB839Cbe05303d7705Fa"],
  });
  const bad = parseArgs(inputs, ["1", "nope"]);
  assert.ok(!bad.ok);
  assert.equal(bad.index, 1);
});

test("the payable value field is ETH, converted to wei, and empty means zero", () => {
  assert.deepEqual(parseEthValue("  "), {ok: true, value: 0n});
  assert.deepEqual(parseEthValue("1"), {ok: true, value: 1_000_000_000_000_000_000n});
  assert.deepEqual(parseEthValue("0.05"), {ok: true, value: 50_000_000_000_000_000n});
  assert.equal(parseEthValue("abc").ok, false);
  assert.equal(parseEthValue("-1").ok, false);
  assert.equal(parseEthValue("0x10").ok, false);
});
