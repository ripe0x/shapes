import {test} from "node:test";
import assert from "node:assert/strict";
import {encodeEventTopics, encodeAbiParameters, parseAbiParameters, parseEther, type Address, type TransactionReceipt} from "viem";
import {buildExplicitFwaPlan, fwaExposure, fwaSettlement, depositBlocker, depositedListing, fwaAbi, mintedPackId, PACKS, FWA_POOL, packTransferAbi, parseFwaSession, type FwaSettings} from "./fwa";
const E = parseEther;
const settings: FwaSettings = {
  denominations: ["0.01","0.05","0.1","0.5","1","5","10","50","100"].map(v => E(v)),
  mintFee: E("0.001"), minimumPack: E("0.03"), minimumBacking: E("0.025"),
  admitted: true, exempt: true, withdrawOnly: false, cap: null, oracleError: null,
  tokenCashoutBps: 9150n, poolWeight: 10n ** 20n, activeListings: 100n, cashoutBps: 9000n, settlementFeeBps: 100n, block: 1n,
};
const account: Address = "0x1000000000000000000000000000000000000123";
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

test("explicit pack choices preserve values even when a budget cap is exceeded", () => {
  const p = buildExplicitFwaPlan([{value:E("0.05"),quantity:1}],10000n,settings,E("0.1"));
  assert.equal(p.rows[0].value,E("0.05")); assert.equal(p.fees,E("0.001"));
  assert.equal(p.total,E("0.101")); assert.equal(p.remainder,-E("0.001"));
  const smaller = buildExplicitFwaPlan([{value:E("0.04"),quantity:1}],10000n,settings);
  assert.equal(smaller.fees,E("0.004")); assert.equal(smaller.total,E("0.084"));
});
test("explicit groups expand quantities and reject unsupported values and backing", () => {
  const p = buildExplicitFwaPlan([{value:E("0.05"),quantity:2},{value:E("0.1"),quantity:1}],5000n,settings);
  assert.deepEqual(p.rows.map(r=>r.value),[E("0.05"),E("0.05"),E("0.1")]);
  assert.equal(p.backing,E("0.1")); assert.equal(p.total,E("0.303"));
  assert.throws(()=>buildExplicitFwaPlan([{value:E("0.051"),quantity:1}],10000n,settings),/denominations/);
  assert.throws(()=>buildExplicitFwaPlan([{value:E("0.03"),quantity:1}],5000n,settings),/minimum backing/);
  assert.throws(()=>buildExplicitFwaPlan([{value:E("0.05"),quantity:25}],10000n,settings),/24/);
});
test("exposure includes every new position in the pool denominator", () => {
  const rows=[{backing:E("0.05")},{backing:E("0.1")}]; const x=fwaExposure(rows,settings);
  assert.equal(x.weights[0],2n*x.weights[1]); assert.equal(x.totalWeight,settings.poolWeight+x.addedWeight);
  assert.equal(x.positions,2n); assert.equal(x.totalPositions,102n);
});
test("settlement separates buyer bid from depositor recovery and principal spent", () => {
  const x=fwaSettlement({value:E("0.05"),backing:E("0.05")},settings);
  assert.equal(x.returnedBacking,E("0.0495")); assert.equal(x.packTakenLoss,E("0.0505"));
  assert.equal(x.packReturnedLoss,E("0.05")); assert.equal(x.cashBid,E("0.045")); assert.equal(x.tokenBidBudget,E("0.04575"));
});
