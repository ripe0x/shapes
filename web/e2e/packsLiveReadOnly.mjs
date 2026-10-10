/** Read-only Sepolia contract check. simulateContract uses eth_call and never broadcasts. */
import assert from "node:assert/strict";
import {createPublicClient, http, parseAbi} from "viem";
import {sepolia} from "viem/chains";

const rpc = "https://gateway.tenderly.co/public/sepolia";
const shapes = "0x6c2f9c00f44fbbf141dd166979903004b80d5f99";
const packs = "0x6DB763fB3FA5B988BEDa8E7a4288c79d7E1E6f45";
const renderer = "0xbFa47D2047D61AE8eAA685008e1272E4F9d6ea60";
const owner = "0xCB43078C32423F5348Cab5885911C3B5faE217F9";
const client = createPublicClient({chain: sepolia, transport: http(rpc)});
const packAbi = parseAbi([
  "function shapes() view returns (address)",
  "function renderer() view returns (address)",
  "function MIN_PACK_VALUE() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function previewCardLimit() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function packState(uint256) view returns ((uint256[] shapeIds,uint32[] counts,uint256 valueWei,uint256 mintedCount,address creator))",
  "function quoteMint(uint32[]) view returns (uint256 backingWei,uint256 feeWei,uint256 totalWei,uint256 shapeCount)",
  "function createPack(uint256[],uint32[]) payable returns (uint256)",
  "function addToPack(uint256,uint256[],uint32[]) payable",
  "function mergePacks(uint256,uint256[])",
  "function open(uint256)",
  "function redeem(uint256)",
  "function unseal(uint256,address)",
  "function claimantOf(uint256) view returns (address)",
  "function contentsOf(uint256) view returns (uint256[])",
  "function claim(uint256,uint256)",
  "function claimEth(uint256,uint256,address)",
  "error NoSourcePacks()",
  "error NotPackOwner(uint256,address)",
]);
const shapeAbi = parseAbi([
  "function denominationCount() view returns (uint8)",
  "function denominationAt(uint8) view returns (uint256)",
  "function mintFee() view returns (uint256)",
  "function backingOf(uint256) view returns (uint256)",
  "function setApprovalForAll(address,bool)",
]);
const rendererAbi = parseAbi([
  "function shapes() view returns (address)",
  "function contractURI(string name,string description,bytes32 seed) view returns (string)",
]);
const packRead = (functionName, args = []) => client.readContract({address: packs, abi: packAbi, functionName, args});
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

assert.equal(await client.getChainId(), sepolia.id);
for (const address of [packs, renderer]) {
  const code = await client.getCode({address});
  assert.ok(code && code !== "0x", `${address} has no Sepolia bytecode`);
}
assert.ok(same(await packRead("shapes"), shapes));
assert.ok(same(await packRead("renderer"), renderer));
assert.ok(same(await client.readContract({address: renderer, abi: rendererAbi, functionName: "shapes"}), shapes));
const collectionUri = await client.readContract({address: renderer, abi: rendererAbi, functionName: "contractURI",
  args: ["Shape Packs", "Sepolia read check", `0x${"00".repeat(32)}`]});
const collectionJson = JSON.parse(Buffer.from(collectionUri.split(",")[1], "base64").toString("utf8"));
const collectionSvg = Buffer.from(collectionJson.image.split(",")[1], "base64").toString("utf8");
assert.match(collectionSvg, /viewBox="0 0 3840 3840"/);
assert.equal([...collectionSvg.matchAll(/<g transform="translate\(/g)].length, 3);
console.log("PASS renderer contractURI with three card slots");
const [minimum, totalMinted, previewCardLimit, denominationCount, unit, mintFee] = await client.multicall({contracts: [
  {address: packs, abi: packAbi, functionName: "MIN_PACK_VALUE"},
  {address: packs, abi: packAbi, functionName: "totalMinted"},
  {address: packs, abi: packAbi, functionName: "previewCardLimit"},
  {address: shapes, abi: shapeAbi, functionName: "denominationCount"},
  {address: shapes, abi: shapeAbi, functionName: "denominationAt", args: [0]},
  {address: shapes, abi: shapeAbi, functionName: "mintFee"},
], allowFailure: false});
assert.equal(minimum, 3n * unit);
assert.ok(previewCardLimit > 0n);
const counts = Array(denominationCount).fill(0);
counts[0] = Number(minimum / unit);
const quote = await packRead("quoteMint", [counts]);
assert.equal(quote[0], minimum);
assert.equal(quote[1], BigInt(counts[0]) * mintFee);
assert.equal(quote[2], quote[0] + quote[1]);
const balance = await client.getBalance({address: owner});
assert.ok(balance >= quote[2], "test account needs enough Sepolia ETH for mint simulation");
await client.simulateContract({address: packs, abi: packAbi, functionName: "createPack",
  args: [[], counts], value: quote[2], account: owner});
console.log("PASS eth_call createPack with exact quote");
await client.simulateContract({address: shapes, abi: shapeAbi, functionName: "setApprovalForAll",
  args: [packs, true], account: owner});
console.log("PASS eth_call setApprovalForAll for new Packs address");
await assert.rejects(() => client.simulateContract({address: packs, abi: packAbi,
  functionName: "mergePacks", args: [1n, []], account: owner}), /NoSourcePacks/);
console.log("PASS eth_call mergePacks rejects an empty source list");

const owned = [];
for (let id = 1n; id <= totalMinted; id++) {
  try {
    if (same(await packRead("ownerOf", [id]), owner)) owned.push(id);
  } catch { /* A burned or transferred pack is not an owned live source. */ }
}
if (owned.length > 0) {
  const target = owned[0];
  const state = await packRead("packState", [target]);
  const backing = (await client.multicall({contracts: state.shapeIds.map((id) =>
    ({address: shapes, abi: shapeAbi, functionName: "backingOf", args: [id]})), allowFailure: false}))
    .reduce((sum, value) => sum + value, 0n);
  assert.equal(state.valueWei, backing);
  await client.simulateContract({address: packs, abi: packAbi, functionName: "open", args: [target], account: owner});
  await client.simulateContract({address: packs, abi: packAbi, functionName: "redeem", args: [target], account: owner});
  await client.simulateContract({address: packs, abi: packAbi, functionName: "unseal", args: [target, owner], account: owner});
  console.log("PASS eth_call open, redeem and unseal");
  if (owned.length > 1) {
    await client.simulateContract({address: packs, abi: packAbi, functionName: "mergePacks",
      args: [target, owned.slice(1)], account: owner});
    console.log("PASS eth_call mergePacks with live target and sources");
  } else {
    console.log("SKIP successful merge simulation: fewer than two live packs owned by test account");
  }
} else {
  console.log("SKIP live pack exit and successful merge simulations: test account owns no live packs");
}
console.log(`PASS live reads: ${totalMinted} minted packs, ${denominationCount} denominations, minimum ${minimum} wei, preview limit ${previewCardLimit}`);
