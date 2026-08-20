// Compare the hand-written ABI in src/chain/abi.ts against the compiled contracts.
//
// The site drives the chain through human-readable signatures typed out by hand. Nothing else
// couples them to the contracts, so a rename or a changed return type stays readable, keeps
// compiling, and fails only at runtime inside viem's decoder. Comparing outputs is the point:
// the drift this was written for was a struct field removed from a return tuple, which no
// selector-level check would see.
//
// Reads `forge inspect <contract> abi --json` on stdin-free child processes; run from preview/.
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {parseAbi} from "viem";

const ROOT = new URL("../../", import.meta.url).pathname;

// Which compiled contract each exported ABI is a view of.
const SOURCES = {shapesAbi: "Shapes", auctionHouseAbi: "ShapeAuctionHouse"};

/** Canonical type, with tuples expanded and array suffixes kept: `(address,uint256)[2]`. */
function typeStr(p) {
  if (!p.type.startsWith("tuple")) return p.type;
  return `(${(p.components ?? []).map(typeStr).join(",")})${p.type.slice(5)}`;
}

/** Canonical form of one ABI entry. Two entries match only if these strings are equal. */
function sig(e) {
  const ins = (e.inputs ?? []).map(typeStr).join(",");
  if (e.type === "event") {
    const parts = (e.inputs ?? []).map((p) => typeStr(p) + (p.indexed ? " indexed" : ""));
    return `event ${e.name}(${parts.join(",")})`;
  }
  if (e.type === "error") return `error ${e.name}(${ins})`;
  const outs = (e.outputs ?? []).map(typeStr).join(",");
  const mut = e.stateMutability ?? "nonpayable";
  return `function ${e.name}(${ins}) ${mut} returns (${outs})`;
}

/** The `parseAbi([...])` string literals in abi.ts, by exported name. */
function vendored() {
  const text = readFileSync(new URL("../src/chain/abi.ts", import.meta.url), "utf8");
  const out = {};
  for (const m of text.matchAll(/export const (\w+) = parseAbi\(\[([\s\S]*?)\]\);/g)) {
    const body = m[2].replace(/^\s*\/\/.*$/gm, ""); // drop comment lines
    out[m[1]] = [...body.matchAll(/"([^"]+)"/g)].map((s) => s[1]);
  }
  return out;
}

function compiled(name) {
  const json = execFileSync("forge", ["inspect", name, "abi", "--json"], {cwd: ROOT, encoding: "utf8"});
  return JSON.parse(json);
}

let failed = 0;
const groups = vendored();

for (const [exportName, contract] of Object.entries(SOURCES)) {
  const lines = groups[exportName];
  if (!lines) {
    console.error(`${exportName}: not found in src/chain/abi.ts`);
    failed++;
    continue;
  }

  // parseAbi resolves the `struct` declarations into tuples, so the vendored side lands in the
  // same shape as the compiled one. Struct declarations produce no ABI entries of their own.
  const mine = parseAbi(lines).filter((e) => e.type !== "constructor");
  const theirs = new Set(compiled(contract).map(sig));

  for (const e of mine) {
    const s = sig(e);
    if (theirs.has(s)) continue;
    // Report the nearest same-name entry, which is what makes a drifted return type obvious.
    const near = [...theirs].filter((t) => t.split(/[ (]/)[1] === e.name);
    console.error(`\n${exportName} -> ${contract}: no match for\n  vendored: ${s}`);
    console.error(near.length ? `  on-chain: ${near.join("\n            ")}` : "  on-chain: no entry of that name");
    failed++;
  }
  console.log(`ok: ${mine.length} signatures in ${exportName} match ${contract}`);
}

if (failed) {
  console.error(`\n${failed} vendored signature(s) do not match the compiled contracts.`);
  console.error("The site would fail at runtime inside viem, not at build time. Fix src/chain/abi.ts.");
  process.exit(1);
}
