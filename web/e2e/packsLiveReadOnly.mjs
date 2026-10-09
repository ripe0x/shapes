/** Read-only Sepolia contract check. simulateContract uses eth_call and never broadcasts. */
import assert from "node:assert/strict";
import {createPublicClient, http, parseAbi} from "viem";
import {sepolia} from "viem/chains";

const rpc = "https://gateway.tenderly.co/public/sepolia";
const shapes = "0x6c2f9c00f44fbbf141dd166979903004b80d5f99";
const packs = "0x5ee5186c1f66b03ba1d675ac60668e168f5306d8";
const client = createPublicClient({chain: sepolia, transport: http(rpc)});
const packAbi = parseAbi([
  "function shapes() view returns (address)",
  "function MIN_PACK_VALUE() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function packState(uint256) view returns ((uint256[] shapeIds,uint32[] counts,uint256 valueWei,uint256 mintedCount,address creator))",
  "function quoteMint(uint32[]) view returns (uint256 backingWei,uint256 feeWei,uint256 totalWei,uint256 shapeCount)",
  "function createPack(uint256[],uint32[]) payable returns (uint256)",
  "function addToPack(uint256,uint256[],uint32[]) payable",
  "function open(uint256)",
  "function redeem(uint256)",
  "function unseal(uint256,address)",
  "function claimantOf(uint256) view returns (address)",
  "function contentsOf(uint256) view returns (uint256[])",
  "function claim(uint256,uint256)",
  "function claimEth(uint256,uint256,address)",
  "error NotClaimant(uint256,address)",
  "error NothingToClaim(uint256)",
]);
const shapeAbi = parseAbi([
  "function denominationCount() view returns (uint8)",
  "function denominationAt(uint8) view returns (uint256)",
  "function mintFee() view returns (uint256)",
  "function backingOf(uint256) view returns (uint256)",
  "function setApprovalForAll(address,bool)",
]);
const packRead = (functionName, args = []) => client.readContract({address: packs, abi: packAbi, functionName, args});

assert.equal((await client.getChainId()), sepolia.id);
assert.equal((await packRead("shapes")).toLowerCase(), shapes);
const [minimum, totalMinted, denominationCount, unit, mintFee] = await client.multicall({contracts: [
  {address: packs, abi: packAbi, functionName: "MIN_PACK_VALUE"},
  {address: packs, abi: packAbi, functionName: "totalMinted"},
  {address: shapes, abi: shapeAbi, functionName: "denominationCount"},
  {address: shapes, abi: shapeAbi, functionName: "denominationAt", args: [0]},
  {address: shapes, abi: shapeAbi, functionName: "mintFee"},
], allowFailure: false});
assert.equal(minimum, 3n * unit);
assert.ok(totalMinted > 0n, "a deployed pack is needed for exit simulations");
const counts = Array(denominationCount).fill(0);
counts[0] = 3;
const quote = await packRead("quoteMint", [counts]);
assert.equal(quote[0], minimum);
assert.equal(quote[1], 3n * mintFee);
assert.equal(quote[2], quote[0] + quote[1]);
const packId = totalMinted;
const [owner, state] = await client.multicall({contracts: [
  {address: packs, abi: packAbi, functionName: "ownerOf", args: [packId]},
  {address: packs, abi: packAbi, functionName: "packState", args: [packId]},
], allowFailure: false});
const backing = (await client.multicall({contracts: state.shapeIds.map((id) =>
  ({address: shapes, abi: shapeAbi, functionName: "backingOf", args: [id]})), allowFailure: false}))
  .reduce((sum, value) => sum + value, 0n);
assert.equal(state.valueWei, backing);
const balance = await client.getBalance({address: owner});
assert.ok(balance >= quote[2], "pack owner needs enough Sepolia ETH for mint simulations");

const simulate = async (functionName, args, value = 0n) => {
  await client.simulateContract({address: packs, abi: packAbi, functionName, args, value, account: owner});
  console.log(`PASS eth_call ${functionName}`);
};
await simulate("createPack", [[], counts], quote[2]);
const oneCount = [...counts];
oneCount[0] = 1;
const oneQuote = await packRead("quoteMint", [oneCount]);
await simulate("addToPack", [packId, [], oneCount], oneQuote[2]);
await simulate("open", [packId]);
await simulate("redeem", [packId]);
await simulate("unseal", [packId, owner]);
await client.simulateContract({address: shapes, abi: shapeAbi, functionName: "setApprovalForAll",
  args: [packs, true], account: owner});
console.log("PASS eth_call setApprovalForAll");
const claimIds = Array.from({length: Number(totalMinted)}, (_, i) => BigInt(i + 1));
const claimants = await client.multicall({contracts: claimIds.map((id) =>
  ({address: packs, abi: packAbi, functionName: "claimantOf", args: [id]})), allowFailure: false});
const claimIndex = claimants.findIndex((claimant) => claimant !== "0x0000000000000000000000000000000000000000");
const liveClaim = claimIndex < 0 ? null : {id: claimIds[claimIndex], claimant: claimants[claimIndex]};
if (liveClaim) {
  await client.simulateContract({address: packs, abi: packAbi, functionName: "claim", args: [liveClaim.id, 1n], account: liveClaim.claimant});
  await client.simulateContract({address: packs, abi: packAbi, functionName: "claimEth",
    args: [liveClaim.id, 1n, liveClaim.claimant], account: liveClaim.claimant});
  console.log("PASS eth_call claim and claimEth");
} else {
  await assert.rejects(() => client.simulateContract({address: packs, abi: packAbi, functionName: "claim",
    args: [packId, 1n], account: owner}), /NothingToClaim/);
  console.log("PASS claim unavailable before unseal; no live unsealed claim for success simulation");
}
console.log(`PASS live reads: ${totalMinted} packs, ${denominationCount} denominations, minimum ${minimum} wei`);
