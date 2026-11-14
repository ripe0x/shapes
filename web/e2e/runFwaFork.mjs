/** Boots a disposable mainnet fork, runs the integration, and always stops the node. */
import {spawn} from 'node:child_process';
import {createPublicClient,http} from 'viem';
const rpc='http://127.0.0.1:18546';
const probe=createPublicClient({transport:http(rpc,{timeout:1000,retryCount:0})});
let occupied=false;
try {await probe.getChainId();occupied=true;} catch {}
if(occupied) throw new Error('Port 18546 is already in use. Stop the existing node before running this test.');
const child=spawn(process.env.ANVIL_BIN ?? 'anvil',['--fork-url',process.env.FWA_FORK_SOURCE ?? 'https://gateway.tenderly.co/public/mainnet','--chain-id','1','--port','18546','--silent'],{stdio:['ignore','ignore','pipe']});
let startupError='';
child.stderr.on('data',d=>{startupError+=d.toString().slice(0,2000)});
child.on('error',e=>{startupError=e.message});
try {
 const client=createPublicClient({transport:http(rpc,{timeout:1000,retryCount:0})});
 let ready=false;
 for(let i=0;i<45;i++){
  try {await client.request({method:'anvil_nodeInfo'});ready=true;break}catch{}
  if(child.exitCode!==null) break;
  await new Promise(r=>setTimeout(r,1000));
 }
 if(!ready) throw new Error(`Anvil did not start: ${startupError}`);
 const test=spawn(process.execPath,['--import','tsx','web/e2e/fwaFork.mjs'],{stdio:'inherit',env:{...process.env,FWA_FORK_RPC:rpc}});
 const result=await new Promise((resolve,reject)=>{test.on('error',reject);test.on('exit',resolve)});
 if(result!==0) throw new Error('The FWA fork integration failed.');
} finally {child.kill();}
