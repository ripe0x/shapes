import {test} from "node:test";
import assert from "node:assert/strict";

import {KIND_ORDER, ROT_COUNT} from "./render";
import {
  KIND_COUNT,
  decodeModuleByte,
  encodeModuleByte,
  isValidModuleByte,
  isValidModuleArray,
  kindIndexOf,
} from "./moduleCodec";

test("KIND_COUNT matches KIND_ORDER length", () => {
  assert.equal(KIND_COUNT, 10);
  assert.equal(KIND_COUNT, KIND_ORDER.length);
});

test("round-trip: every kind, every valid rotation, both solid states", () => {
  for (let kindIndex = 0; kindIndex < KIND_COUNT; kindIndex++) {
    const kind = KIND_ORDER[kindIndex];
    const rotCount = ROT_COUNT[kind];
    for (let rotCode = 0; rotCode < rotCount; rotCode++) {
      const rot = rotCode * 90;
      for (const solid of [true, false]) {
        const b = encodeModuleByte(kindIndex, solid, rot);
        assert.equal(isValidModuleByte(b), true, `byte 0x${b.toString(16)} should be valid`);
        const decoded = decodeModuleByte(b);
        assert.equal(decoded.kindIndex, kindIndex);
        assert.equal(decoded.kind, kind);
        assert.equal(decoded.solid, solid);
        assert.equal(decoded.rot, rot);
      }
    }
  }
});

test("kindIndexOf agrees with KIND_ORDER position", () => {
  for (let i = 0; i < KIND_ORDER.length; i++) {
    assert.equal(kindIndexOf(KIND_ORDER[i]), i);
  }
});

test("rejects bit 7 set", () => {
  const validByte = encodeModuleByte(0, false, 0); // circle, outline, rot 0 -> 0x00
  const withBit7 = validByte | 0x80;
  assert.equal(isValidModuleByte(withBit7), false);
  assert.throws(() => decodeModuleByte(withBit7));
});

test("rejects kind >= KIND_COUNT", () => {
  // bits 3..0 = 10..15 are all invalid kinds regardless of the other bits
  for (let kindIndex = KIND_COUNT; kindIndex <= 0x0f; kindIndex++) {
    assert.equal(isValidModuleByte(kindIndex), false);
    assert.throws(() => decodeModuleByte(kindIndex));
  }
  assert.throws(() => encodeModuleByte(KIND_COUNT, false, 0));
});

test("rejects rot >= rotCount(kind) per kind", () => {
  for (let kindIndex = 0; kindIndex < KIND_COUNT; kindIndex++) {
    const kind = KIND_ORDER[kindIndex];
    const rotCount = ROT_COUNT[kind];
    for (let rotCode = rotCount; rotCode < 4; rotCode++) {
      const b = (rotCode << 5) | kindIndex; // solid bit clear, bit 7 clear
      assert.equal(
        isValidModuleByte(b),
        false,
        `kind ${kind} rotCode ${rotCode} (max ${rotCount}) should be invalid`,
      );
      assert.throws(() => decodeModuleByte(b));
      assert.throws(() => encodeModuleByte(kindIndex, false, rotCode * 90));
    }
  }
});

test("isValidModuleArray: all-valid array is valid, one bad byte invalidates it", () => {
  const good = new Uint8Array([
    encodeModuleByte(0, true, 0),
    encodeModuleByte(9, false, 90), // line, rotCount 2, rotCode 1 valid
  ]);
  assert.equal(isValidModuleArray(good), true);

  const bad = new Uint8Array([...good, 0x80]); // bit 7 set
  assert.equal(isValidModuleArray(bad), false);
});
