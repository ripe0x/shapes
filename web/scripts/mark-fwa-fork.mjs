/** Prepare the local FWA fork: identify it and fund the owner's test wallet. */
import {randomBytes} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {createPublicClient, http} from 'viem';
import {mainnet} from 'viem/chains';

const MAINNET_RPC = 'https://mainnet.gateway.tenderly.co';
const FUNDING_ENS = 'ripe0x.eth';
const FUNDING_FLOOR = 1000n * 10n ** 18n;

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
const node = await rpc('anvil_nodeInfo');
if (await rpc('eth_chainId') !== '0x7a69') throw new Error('Anvil is not running on chain 31337.');
if (node.forkConfig?.forkUrl !== MAINNET_RPC || !node.forkConfig.forkBlockNumber)
  throw new Error('Anvil must be a pinned Tenderly Ethereum mainnet fork.');
let marker = deployment.fwaForkMarker;
const existingMarker = marker && marker.balanceWei === '1' && /^0x[\da-f]{40}$/i.test(marker.address) &&
  BigInt(await rpc('eth_getBalance', [marker.address, 'latest'])) === 1n;
if (!existingMarker) {
  const address = `0x${randomBytes(20).toString('hex')}`;
  if (BigInt(await rpc('eth_getBalance', [address, 'latest'])) !== 0n || await rpc('eth_getCode', [address, 'latest']) !== '0x')
    throw new Error('Generated marker address is occupied. Run the setup again.');
  await rpc('anvil_setBalance', [address, '0x1']);
  if (BigInt(await rpc('eth_getBalance', [address, 'latest'])) !== 1n) throw new Error('Anvil did not install the marker.');
  marker = {address, balanceWei:'1'};
  deployment.fwaForkMarker = marker;
}
const live = createPublicClient({chain:mainnet, transport:http(MAINNET_RPC)});
const fundedAddress = await live.getEnsAddress({name:FUNDING_ENS});
if (!fundedAddress) throw new Error(`${FUNDING_ENS} did not resolve on Ethereum mainnet.`);
const startingBalance = BigInt(await rpc('eth_getBalance', [fundedAddress, 'latest']));
if (startingBalance < FUNDING_FLOOR)
  await rpc('anvil_setBalance', [fundedAddress, `0x${FUNDING_FLOOR.toString(16)}`]);
const fundedBalance = BigInt(await rpc('eth_getBalance', [fundedAddress, 'latest']));
if (fundedBalance < FUNDING_FLOOR) throw new Error('Anvil did not fund the test wallet.');
deployment.fwaForkFunding = {ens:FUNDING_ENS, address:fundedAddress, minimumBalanceWei:String(FUNDING_FLOOR), markerAddress:marker.address};
await writeFile(path, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`Prepared ${url.host}: ${FUNDING_ENS} (${fundedAddress}) has at least 1,000 fork ETH. Reload the fork frontend.`);
