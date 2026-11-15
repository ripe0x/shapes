import {test} from "node:test";
import assert from "node:assert/strict";
import {encodeEventTopics, encodeAbiParameters, parseAbiParameters, parseEther, type Address, type TransactionReceipt} from "viem";
import {suggestFwaPlan, buildFwaContribution, parseFwaAmount, fwaPackRequirement, buildExplicitFwaPlan, fwaExposure, fwaSettlement, depositBlocker, depositedListing, fwaAbi, mintedPackId, PACKS, FWA_POOL, packTransferAbi, parseFwaSession, type FwaSettings} from "./fwa";
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

test("manual five pack mix totals five shape fees", () => {
  const packs = ["0.1","0.1","0.05","0.05","0.05"].map(v => ({value:E(v), backing:E(v)}));
  const p = buildFwaContribution(packs, settings, E("0.75"));
  assert.equal(p.packValue,E("0.35")); assert.equal(p.backing,E("0.35"));
  assert.equal(p.fees,E("0.005")); assert.equal(p.total,E("0.705")); assert.equal(p.remainder,E("0.045"));
});
test("custom backing remains independent and the cap never changes chosen amounts", () => {
  const p = buildFwaContribution([{value:E("0.04"),backing:E("0.07")},{value:E("0.15"),backing:E("0.025")}],settings,E("0.2"));
  assert.deepEqual(p.rows[0].counts,[4,0,0,0,0,0,0,0,0]); assert.deepEqual(p.rows[1].counts,[0,1,1,0,0,0,0,0,0]);
  assert.equal(p.fees,E("0.006")); assert.equal(p.total,E("0.291")); assert.equal(p.remainder,-E("0.091"));
  assert.equal(p.rows[1].backing,E("0.025"));
});
test("below minimum plans retain their cost and identify the offending requirement", () => {
  const p = buildFwaContribution([{value:E("0.01"),backing:E("0.01")}],settings,E("1"));
  assert.equal(p.total,E("0.021")); assert.match(fwaPackRequirement(p.rows[0],settings)!,/Minimum pack value/);
  assert.match(fwaPackRequirement({value:E("0.05"),backing:E("0.024")},settings)!,/Minimum FWA backing/);
  assert.equal(fwaPackRequirement({value:E("0.05"),backing:E("0.025")},settings),null);
});
test("decimal inputs preserve wei exactly and reject excess precision", () => {
  assert.equal(parseFwaAmount("0.100000000000000001"),100000000000000001n);
  assert.equal(parseFwaAmount(".5"),E("0.5"));
  for (const v of ["", "-1", "1e3", "0.0000000000000000001", "NaN"]) assert.throws(()=>parseFwaAmount(v),/18 decimal/);
});

test("equal suggestions derive single shape packs from budget and live prices", () => {
  const p = suggestFwaPlan(E("0.75"),10000n,settings,"equal");
  assert.equal(p.rows.length,7); assert.ok(p.rows.every(r=>r.value===E("0.05")));
  assert.equal(p.total,E("0.707")); assert.equal(p.remainder,E("0.043"));
  const higherFee=suggestFwaPlan(E("0.75"),10000n,{...settings,mintFee:E("0.01")},"equal");
  assert.equal(higherFee.rows.length,6);
});
test("fewer positions fills with the next affordable denomination and the base size", () => {
  const p=suggestFwaPlan(E("0.75"),10000n,settings,"fewer");
  assert.deepEqual(p.rows.map(r=>r.value),[E("0.1"),E("0.1"),E("0.1"),E("0.05")]);
  assert.equal(p.total,E("0.704")); assert.equal(p.fees,E("0.004"));
});
test("suggestions respect ratio, current minimums, oracle caps and transaction count", () => {
  for(const budget of ["0.1","0.75","2.6","10","100"]) for(const ratio of [5000n,10000n,15000n,20000n]) {
    try {const p=suggestFwaPlan(E(budget),ratio,settings); assert.ok(p.rows.length<=24); assert.ok(p.total<=E(budget));
      for(const r of p.rows) {assert.equal(r.backing,r.value*ratio/10000n); assert.equal(fwaPackRequirement(r,settings),null);}}
    catch(e) {assert.match((e as Error).message,/cannot fund/);}
  }
  assert.equal(suggestFwaPlan(E("1"),10000n,{...settings,minimumPack:E("0.1"),minimumBacking:E("0.1")}).rows[0].value,E("0.1"));
  const capped={...settings,exempt:false,cap:E("0.04")};
  const p=suggestFwaPlan(E("0.75"),10000n,capped); assert.ok(p.rows.every(r=>r.backing<=E("0.04")));
});
test("small budgets disclose compound shape costs and never suggest an unaffordable clean pack", () => {
  const p=suggestFwaPlan(E("0.1"),10000n,settings,"equal");
  assert.equal(p.rows.length,1); assert.equal(p.rows[0].value,E("0.04")); assert.equal(p.fees,E("0.004")); assert.equal(p.total,E("0.084"));
  assert.throws(()=>suggestFwaPlan(E("0.05"),10000n,settings),/cannot fund/);
});

test("most positions is the default and fits fifteen minimum packs into one eth", () => {
  const p=suggestFwaPlan(E("1"),10000n,settings);
  assert.equal(p.rows.length,15); assert.ok(p.rows.every(r=>r.value===E("0.03")));
  assert.equal(p.fees,E("0.045")); assert.equal(p.total,E("0.945")); assert.equal(p.remainder,E("0.055"));
});
test("most positions accounts for fee cliffs, backing minimums and the batch limit", () => {
  const expensive=suggestFwaPlan(E("1"),10000n,{...settings,mintFee:E("0.1")},"most");
  assert.ok(expensive.rows.every(r=>r.value===E("0.05"))); assert.equal(expensive.rows.length,5);
  const half=suggestFwaPlan(E("1"),5000n,settings,"most"); assert.equal(half.rows[0].value,E("0.05")); assert.equal(half.rows.length,13);
  const capped=suggestFwaPlan(E("10"),10000n,settings,"most"); assert.equal(capped.rows.length,24); assert.ok(capped.total<=E("10"));
});
test("most positions matches an exhaustive cost search across denomination carries", () => {
  for (const min of ["0.03","0.06","0.16","0.51"]) for(const fee of ["0.001","0.1"]) {
    const live={...settings,minimumPack:E(min),mintFee:E(fee)};
    const p=suggestFwaPlan(E("10"),10000n,live,"most");
    let cheapest=E("100");
    for(let i=1n;i<=100n;i++) {const value=i*E("0.01"); if(value<live.minimumPack || value<live.minimumBacking)continue;
      const candidate=buildFwaContribution([{value,backing:value}],live,E("10")); if(candidate.total<cheapest)cheapest=candidate.total;}
    assert.equal(p.rows[0].payment+p.rows[0].backing,cheapest);
  }
});
