import {test} from "node:test";
import assert from "node:assert/strict";
import {encodeEventTopics, encodeAbiParameters, parseAbiParameters, parseEther, type Address, type TransactionReceipt} from "viem";
import {buildFwaPlan, depositBlocker, depositedListing, fwaAbi, mintedPackId, PACKS, FWA_POOL, packTransferAbi, parseFwaSession, type FwaSettings} from "./fwa";
const E = parseEther;
const settings: FwaSettings = {
  denominations: ["0.01","0.05","0.1","0.5","1","5","10","50","100"].map(v => E(v)),
  mintFee: E("0.001"), minimumPack: E("0.03"), minimumBacking: E("0.025"),
  admitted: true, exempt: true, withdrawOnly: false, cap: null, oracleError: null,
  cashoutBps: 9000n, settlementFeeBps: 100n, block: 1n,
};
const account: Address = "0x1000000000000000000000000000000000000123";
test("budget covers all underlying mint fees and both independent eth commitments", () => {
  const p = buildFwaPlan(E("1"), 2, 10_000n, false, settings);
  assert.equal(p.rows[0].value, E("0.24"));
  assert.equal(p.rows[0].fee, E("0.006"));
  assert.equal(p.total, E("0.972"));
  assert.equal(p.remainder, E("0.028"));
  assert.equal(p.total + p.remainder, E("1"));
});
test("varied packs preserve the ratio and respect both minimums", () => {
  const p = buildFwaPlan(E("1"), 3, 5000n, true, settings);
  assert.equal(p.rows[1].value, p.rows[0].value * 2n);
  assert.equal(p.rows[2].value, p.rows[0].value * 3n);
  for (const r of p.rows) {
    assert.equal(r.backing, r.value / 2n);
    assert.ok(r.value >= settings.minimumPack);
    assert.ok(r.backing >= settings.minimumBacking);
  }
  assert.ok(p.total <= E("1"));
});
test("all supported splits stay within budget including fee jumps at denomination boundaries", () => {
  for (const budget of ["0.1","0.51","1","3","10"]) for (const count of [1,2,5,12,24]) for (const ratio of [5000n,10000n,20000n]) {
    try {
      const p = buildFwaPlan(E(budget), count, ratio, true, settings);
      assert.ok(p.total <= E(budget));
      for (const r of p.rows) assert.equal(r.counts.reduce((s,n,i) => s + BigInt(n) * settings.denominations[i],0n),r.value);
    } catch (e) {assert.match((e as Error).message,/Increase your budget/);}
  }
});
test("reject invalid inputs and undersized backing", () => {
  assert.throws(() => buildFwaPlan(E("0.05"),1,10000n,false,settings),/Increase/);
  assert.throws(() => buildFwaPlan(E("1"),25,10000n,false,settings),/24/);
  assert.throws(() => buildFwaPlan(E("1"),2,0n,false,settings),/percentage|backing/);
});
test("admission and oracle exemptions are separate, and no invalid deposit is enabled", () => {
  const rows=[{backing:E("0.25")}];
  assert.match(depositBlocker({...settings,admitted:false},rows)!,/admission/);
  assert.match(depositBlocker({...settings,exempt:false},rows)!,/ceiling/);
  assert.match(depositBlocker({...settings,exempt:false,oracleError:"stale quote"},rows)!,/stale/);
  assert.match(depositBlocker({...settings,withdrawOnly:true},rows)!,/withdrawals/);
  assert.equal(depositBlocker({...settings,exempt:false,cap:E("0.25")},rows),null);
  assert.match(depositBlocker(settings,[{backing:0n}])!,/minimum/);
});
test("saved sessions are scoped to the wallet and validate transaction hashes and counts", () => {
  const s={version:1,account,rows:[{counts:[0,1,0,0,0,0,0,0,0],value:String(E("0.05")),backing:String(E("0.05")),fee:String(E("0.001")),mintHash:`0x${"ab".repeat(32)}`} ]};
  assert.deepEqual(parseFwaSession(JSON.stringify(s),account),s);
  assert.equal(parseFwaSession(JSON.stringify(s),FWA_POOL),null);
  assert.equal(parseFwaSession(JSON.stringify({...s,rows:[{...s.rows[0],counts:[-1]}]}),account),null);
  assert.equal(parseFwaSession(JSON.stringify({...s,rows:[{...s.rows[0],mintHash:"invalid"}]}),account),null);
});
const receipt = (address: Address, topics: readonly string[], data: `0x${string}`) => ({logs:[{address,topics,data}]} as unknown as TransactionReceipt);
test("decode mint IDs from the confirmed pack receipt, never from a predicted counter", () => {
  const topics=encodeEventTopics({abi:packTransferAbi,eventName:"Transfer",args:{from:"0x0000000000000000000000000000000000000000",to:account,tokenId:41n}});
  assert.equal(mintedPackId(receipt(PACKS,topics as string[],"0x"),account),41n);
  assert.throws(() => mintedPackId(receipt(FWA_POOL,topics as string[],"0x"),account),/identified/);
});
test("decode both active and staged listing receipts with the deployed event signatures", () => {
  const topics=encodeEventTopics({abi:fwaAbi,eventName:"NFTListed",args:{listingId:52n,slot:8n,depositor:account}});
  const data=encodeAbiParameters(parseAbiParameters("address,uint256,uint256,uint256"),[PACKS,41n,10n,E("0.25")]);
  assert.deepEqual(depositedListing(receipt(FWA_POOL,topics as string[],data),account,41n),{listingId:"52",staged:false});
  const stagedTopics=encodeEventTopics({abi:fwaAbi,eventName:"ListingStaged",args:{listingId:53n,depositor:account}});
  const stagedData=encodeAbiParameters(parseAbiParameters("address,uint256,uint256,uint256"),[PACKS,41n,E("0.25"),10n]);
  assert.deepEqual(depositedListing(receipt(FWA_POOL,stagedTopics as string[],stagedData),account,41n),{listingId:"53",staged:true});
});
