/** Boots a disposable mainnet fork, runs the integration, and always stops the node. */
import {spawn} from 'node:child_process';
import {createPublicClient,http} from 'viem';
const rpc='http://127.0.0.1:18546';
const peerRpc='http://127.0.0.1:18547';
for(const url of [rpc,peerRpc]){
 const probe=createPublicClient({transport:http(url,{timeout:1000,retryCount:0})});
 let occupied=false;
 try {await probe.getChainId();occupied=true;} catch {}
 if(occupied) throw new Error(`${url} is already in use. Stop the existing node before running this test.`);
}
const forkArgs=['--fork-url',process.env.FWA_FORK_SOURCE ?? 'https://mainnet.gateway.tenderly.co','--fork-block-number',process.env.FWA_FORK_BLOCK ?? '26418101','--chain-id','1','--silent'];
const children=[18546,18547].map(port=>spawn(process.env.ANVIL_BIN ?? 'anvil',[...forkArgs,'--port',String(port)],{stdio:['ignore','ignore','pipe']}));
let startupError='';
for(const child of children){child.stderr.on('data',d=>{startupError+=d.toString().slice(0,2000)});child.on('error',e=>{startupError=e.message});}
try {
 for(const url of [rpc,peerRpc]){
  const client=createPublicClient({transport:http(url,{timeout:1000,retryCount:0})});
  let ready=false;
  for(let i=0;i<45;i++){
   try {await client.request({method:'anvil_nodeInfo'});ready=true;break}catch{}
   if(children.some(child=>child.exitCode!==null)) break;
   await new Promise(r=>setTimeout(r,1000));
  }
  if(!ready) throw new Error(`Anvil did not start at ${url}: ${startupError}`);
 }
 const test=spawn(process.execPath,['--import','tsx','web/e2e/fwaFork.mjs'],{stdio:'inherit',env:{...process.env,FWA_FORK_RPC:rpc,FWA_PEER_RPC:peerRpc}});
 const result=await new Promise((resolve,reject)=>{test.on('error',reject);test.on('exit',resolve)});
 if(result!==0) throw new Error('The FWA fork integration failed.');
} finally {for(const child of children) child.kill();}
