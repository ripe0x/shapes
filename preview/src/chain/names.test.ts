import {test} from "node:test";
import assert from "node:assert/strict";
import type {ResolvedName} from "@1001-digital/ethereum-names";

import {createNameResolver, nameFromLookup, type NameStorage} from "./names";

const A = "0xCB43078C32423F5348Cab5885911C3B5faE217F9";
const B = "0x8a49bb7bfd3e37cbb1a0cd4d0e0a8e5f2b3c4d5e";

function memoryStorage(): NameStorage & {items: Record<string, string>} {
  const items: Record<string, string> = {};
  return {
    items,
    getItem: (key) => items[key] ?? null,
    setItem: (key, value) => {
      items[key] = value;
    },
  };
}

/** A lookup that records every address it was asked for and the peak concurrent call count. */
function fakeLookup(names: Record<string, string | null>, delayMs = 5) {
  const calls: string[] = [];
  let live = 0;
  let peak = 0;
  const lookup = async (address: string) => {
    calls.push(address);
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((done) => setTimeout(done, delayMs));
    live -= 1;
    return {name: names[address.toLowerCase()] ?? null, ok: true};
  };
  return {
    lookup,
    calls,
    get peak() {
      return peak;
    },
  };
}

test("a resolved name is cached, so a second request issues no lookup", async () => {
  const fake = fakeLookup({[A.toLowerCase()]: "shapes.eth"});
  const resolver = createNameResolver({lookup: fake.lookup, batchMs: 1});

  assert.equal(resolver.peek(A), undefined);
  assert.equal(await resolver.resolve(A), "shapes.eth");
  assert.equal(await resolver.resolve(A.toLowerCase()), "shapes.eth");
  assert.equal(resolver.peek(A), "shapes.eth");
  assert.deepEqual(fake.calls, [A.toLowerCase()]);
});

test("concurrent requests for one address share a single lookup", async () => {
  const fake = fakeLookup({[A.toLowerCase()]: "shapes.gwei"});
  const resolver = createNameResolver({lookup: fake.lookup, batchMs: 5});

  const results = await Promise.all([A, A, A, A].map((address) => resolver.resolve(address)));

  assert.deepEqual(results, ["shapes.gwei", "shapes.gwei", "shapes.gwei", "shapes.gwei"]);
  assert.equal(fake.calls.length, 1);
});

test("addresses requested within the batch window resolve together, at most four at a time", async () => {
  const addresses = Array.from({length: 20}, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
  const fake = fakeLookup({});
  const resolver = createNameResolver({lookup: fake.lookup, batchMs: 20, concurrency: 4});

  const pending = addresses.map((address) => resolver.resolve(address));
  // Requested after the first, still inside the window: the same batch picks them up.
  await new Promise((done) => setTimeout(done, 5));
  const late = resolver.resolve(addresses[0]);

  assert.deepEqual(await Promise.all([...pending, late]), addresses.map(() => null).concat(null));
  assert.equal(fake.calls.length, 20);
  assert.ok(fake.peak <= 4, `peak concurrency ${fake.peak}`);
});

test("a failed lookup is answered as no name and not retried this session", async () => {
  const calls: string[] = [];
  const resolver = createNameResolver({
    lookup: async (address) => {
      calls.push(address);
      throw new Error("rpc down");
    },
    batchMs: 1,
    storageKey: "test.names",
    storage: memoryStorage(),
  });

  assert.equal(await resolver.resolve(A), null);
  assert.equal(await resolver.resolve(A), null);
  assert.equal(calls.length, 1);
});

test("the cache is mirrored to storage and rehydrated without a lookup", async () => {
  const storage = memoryStorage();
  const first = fakeLookup({[A.toLowerCase()]: "shapes.wei"});
  const resolverA = createNameResolver({
    lookup: first.lookup,
    batchMs: 1,
    storageKey: "test.names",
    storage,
  });
  await resolverA.resolve(A);
  // The storage mirror is written once the batch completes, just after the name is handed back.
  await new Promise((done) => setTimeout(done, 5));

  const second = fakeLookup({});
  const resolverB = createNameResolver({
    lookup: second.lookup,
    batchMs: 1,
    storageKey: "test.names",
    storage,
  });

  assert.equal(resolverB.peek(A), "shapes.wei");
  assert.equal(await resolverB.resolve(A), "shapes.wei");
  assert.equal(second.calls.length, 0);
});

test("a failed lookup is not written to storage", async () => {
  const storage = memoryStorage();
  const resolver = createNameResolver({
    lookup: async () => ({name: null, ok: false}),
    batchMs: 1,
    storageKey: "test.names",
    storage,
  });

  await resolver.resolve(B);
  assert.equal(storage.items["test.names"], undefined);
});

test("an unverified reverse name is never presented, and an error is not a durable answer", () => {
  const claimed = {system: "ens", name: "someone-elses.eth", status: "unverified", verified: false} as const;
  const unverified = {
    input: A,
    name: null,
    address: A,
    system: "ens",
    status: "unverified",
    verified: false,
    ambiguous: false,
    matches: [claimed],
  } as unknown as ResolvedName;
  assert.deepEqual(nameFromLookup(unverified), {name: null, ok: true});

  const resolved = {...unverified, name: "shapes.eth", status: "resolved", verified: true} as unknown as ResolvedName;
  assert.deepEqual(nameFromLookup(resolved), {name: "shapes.eth", ok: true});

  const failed = {...unverified, status: "error"} as unknown as ResolvedName;
  assert.deepEqual(nameFromLookup(failed), {name: null, ok: false});
});
