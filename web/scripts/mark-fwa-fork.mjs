/** Install a public per-instance marker on a local Anvil fork for FWA wallet checks. */
import {randomBytes} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';

const path = process.env.SHAPES_DEPLOYMENT_FILE;
if (!path) throw new Error('Set SHAPES_DEPLOYMENT_FILE to the local fork deployment record.');
const deployment = JSON.parse(await readFile(path, 'utf8'));
const url = new URL(deployment.rpc);
if (deployment.chainId !== 31337 || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  throw new Error('The deployment record must target a loopback Anvil fork on chain 31337.');

const rpc = async (method, params = []) => {
  const response = await fetch(url, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(`${method} failed on ${url.host}.`);
  return body.result;
};
await rpc('anvil_nodeInfo');
if (await rpc('eth_chainId') !== '0x7a69') throw new Error('Anvil is not running on chain 31337.');
const address = `0x${randomBytes(20).toString('hex')}`;
if (BigInt(await rpc('eth_getBalance', [address, 'latest'])) !== 0n || await rpc('eth_getCode', [address, 'latest']) !== '0x')
  throw new Error('Generated marker address is occupied. Run the setup again.');
await rpc('anvil_setBalance', [address, '0x1']);
if (BigInt(await rpc('eth_getBalance', [address, 'latest'])) !== 1n) throw new Error('Anvil did not install the marker.');
deployment.fwaForkMarker = {address, balanceWei:'1'};
await writeFile(path, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`Installed a public 1-wei FWA marker on ${url.host}. Reload the fork frontend.`);
