/** Run only against an isolated mainnet fork. No mocks and no mainnet broadcasts. */
import assert from "node:assert/strict";
import {createPublicClient,createWalletClient,http,parseAbi,parseEther} from "viem";
import {mainnet} from "viem/chains";
import {FWA_POOL,PACKS,SHAPES,fwaAbi,packTransferAbi,buildFwaPlan,loadFwaSettings,mintedPackId,depositedListing,reconcileFwaSession} from "../../preview/src/site/fwa.ts";
import {packsAbi} from "../../preview/src/site/packs.ts";
const rpc = process.env.FWA_FORK_RPC ?? 'http://127.0.0.1:18546';
const url = new URL(rpc);
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'This script only runs against a loopback fork');
const client=createPublicClient({chain:mainnet,transport:http(rpc,{timeout:30000,retryCount:0})});
const wallet=createWalletClient({chain:mainnet,transport:http(rpc,{timeout:30000,retryCount:0})});
await client.request({method:'anvil_nodeInfo'}); // Fail before any write on a real Ethereum node.
assert.equal(await client.getChainId(),1);
const account='0x1000000000000000000000000000000000000123';
const owner=await client.readContract({address:FWA_POOL,abi:parseAbi(['function owner() view returns(address)']),functionName:'owner'});
const snapshot=await client.request({method:'evm_snapshot'});
try {
 await client.request({method:'anvil_impersonateAccount',params:[account]});
 await client.request({method:'anvil_impersonateAccount',params:[owner]});
 for(const a of [account,owner]) await client.request({method:'anvil_setBalance',params:[a,'0x56bc75e2d63100000']});
 const send=async(address,abi,functionName,args,value,sender=account)=>{
  const request={address,abi,functionName,args,value,account:sender};
  await client.simulateContract(request);
  const gas=(await client.estimateContractGas(request))*3n/2n;
  const hash=await wallet.writeContract({...request,gas});
  const receipt=await client.waitForTransactionReceipt({hash});
  assert.equal(receipt.status,'success');return receipt;
 };
 const settings=await loadFwaSettings(client);
 console.log('Verified live contracts',String(settings.block),'admitted',settings.admitted,'exempt',settings.exempt);
 const plan=buildFwaPlan(parseEther('1'),2,10000n,false,settings);
 const ids=[];
 for(const row of plan.rows){
  const quote=await client.readContract({address:PACKS,abi:packsAbi,functionName:'quoteMint',args:[row.counts]});
  assert.equal(quote[0],row.value);assert.equal(quote[1],row.fee);assert.equal(quote[2],row.payment);
  const receipt=await send(PACKS,packsAbi,'createPack',[[],row.counts],quote[2]);
  const id=mintedPackId(receipt,account);ids.push(id);
  assert.equal((await client.readContract({address:PACKS,abi:packsAbi,functionName:'ownerOf',args:[id]})).toLowerCase(),account.toLowerCase());
  const recovered=await reconcileFwaSession(client,{version:1,account,rows:[{value:String(row.value),backing:String(row.backing),fee:String(row.fee),counts:row.counts,mintHash:receipt.transactionHash}]});
  assert.equal(recovered.rows[0].packId,String(id));
  console.log('PASS real shape pack mint and reload recovery',String(id));
 }
 await send(PACKS,packTransferAbi,'setApprovalForAll',[FWA_POOL,true]);
 if(!settings.admitted) {
  await assert.rejects(()=>client.simulateContract({address:FWA_POOL,abi:fwaAbi,functionName:'listNFT',args:[PACKS,ids[0]],account,value:plan.rows[0].backing}),/CollectionNotWhitelisted/);
  console.log('PASS actual admission gate rejects deposit');
 }
 // Enable the announced admission policy on this disposable fork only.
 const policyAbi=parseAbi(['function setCollectionsWhitelisted(address[],bool)','function setOracleExemptCollection(address,bool)','function unsettledAcquisitionCount() view returns(uint256)','function processAcquisitions(uint256)']);
 const pending=await client.readContract({address:FWA_POOL,abi:policyAbi,functionName:'unsettledAcquisitionCount'});
 if(pending>0n){await client.request({method:'anvil_mine',params:['0x200']});await send(FWA_POOL,policyAbi,'processAcquisitions',[1000n],undefined,owner);}
 await send(FWA_POOL,policyAbi,'setCollectionsWhitelisted',[[PACKS],true],undefined,owner);
 await send(FWA_POOL,policyAbi,'setOracleExemptCollection',[PACKS,true],undefined,owner);
 for(let i=0;i<ids.length;i++){
  const receipt=await send(FWA_POOL,fwaAbi,'listNFT',[PACKS,ids[i]],plan.rows[i].backing);
  const listing=depositedListing(receipt,account,ids[i]);
  const l=await client.readContract({address:FWA_POOL,abi:parseAbi(['function listings(uint256) view returns(address collection,address depositor,address purchaser,uint256 tokenId,uint256 weight,uint256 value,uint256 feeShare,uint256 feeDebt,uint256 slot,uint64 allocatedAt,uint8 status)']),functionName:'listings',args:[BigInt(listing.listingId)]});
  assert.equal(l[0].toLowerCase(),PACKS);assert.equal(l[1].toLowerCase(),account.toLowerCase());assert.equal(l[3],ids[i]);assert.equal(l[5],plan.rows[i].backing);
  assert.equal((await client.readContract({address:PACKS,abi:packsAbi,functionName:'ownerOf',args:[ids[i]]})).toLowerCase(),FWA_POOL.toLowerCase());
  const recovered=await reconcileFwaSession(client,{version:1,account,rows:[{value:String(plan.rows[i].value),backing:String(plan.rows[i].backing),fee:String(plan.rows[i].fee),counts:plan.rows[i].counts,packId:String(ids[i]),depositHash:receipt.transactionHash}]});
  assert.equal(recovered.rows[0].listingId,listing.listingId);
  console.log('PASS direct wallet deposit and reload recovery',listing,'depositor',l[1]);
 }
 console.log('PASS deployed shapes',SHAPES,'and packs plus FWA on a real mainnet fork');
} finally { await client.request({method:'evm_revert',params:[snapshot]}); }
