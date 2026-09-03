/**
 * A wallet for the browser end-to-end run: an EIP-1193 provider installed on the page as
 * `window.ethereum` and announced over EIP-6963, whose requests are answered in Node by a viem
 * wallet client on the local chain.
 *
 * Signing stays in Node so no bundler is needed for the page: the provider forwards every method
 * over one Playwright binding, and this module answers the account, chain and signing methods and
 * relays the rest to the RPC.
 */
import {createWalletClient, defineChain, http, toHex} from "viem";
import {privateKeyToAccount} from "viem/accounts";

/** Anvil's well-known account 1. Public test key, funded on every anvil chain, never used
 *  anywhere with value. Account 0 is the deployer, so the wallet under test is a second account
 *  that owns nothing until it mints. */
const TEST_ACCOUNT_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const PROVIDER_INFO = {
  uuid: "6b1f0e5a-8f30-4f9b-9d0d-3f4c2a7b1e55",
  name: "Shapes E2E Wallet",
  rdns: "wtf.ripe.shapes.e2e",
  icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjxyZWN0IHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz48L3N2Zz4=",
};

const BINDING = "__shapesWalletRequest";

/** Runs in the page. Defines the provider and announces it; every call is relayed to the binding
 *  this file installs. Serialized by Playwright, so it may not close over anything. */
function installProvider({binding, info}) {
  const listeners = new Map();
  const provider = {
    isShapesE2E: true,
    request: ({method, params}) => window[binding](method, params ?? []),
    on(event, handler) {
      const forEvent = listeners.get(event) ?? new Set();
      forEvent.add(handler);
      listeners.set(event, forEvent);
      return provider;
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
      return provider;
    },
  };
  window.ethereum = provider;

  const announce = () =>
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: Object.freeze({info, provider}),
      }),
    );
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}

/**
 * Installs the wallet on a Playwright page. Call before the first navigation: the provider must
 * exist before the app's connector discovery runs.
 */
export async function installTestWallet(page, {rpcUrl, chainId}) {
  const account = privateKeyToAccount(TEST_ACCOUNT_KEY);
  const chain = defineChain({
    id: chainId,
    name: "Shapes dev chain",
    nativeCurrency: {name: "Ether", symbol: "ETH", decimals: 18},
    rpcUrls: {default: {http: [rpcUrl]}},
  });
  const wallet = createWalletClient({account, chain, transport: http(rpcUrl)});

  const relay = async (method, params) => {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
    });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };

  // The wallet starts locked, so `eth_accounts` is empty until the site asks for approval. Without
  // that, wagmi's reconnect finds an already-authorized provider on load and the run never
  // exercises the connect control.
  let authorized = false;
  /** Every transaction this wallet signed, oldest first, so a step can price the gas of the write
   *  it just triggered without reading it back out of the page. */
  const sent = [];

  /**
   * The gas limit for a transaction the site submitted without one, which is every write it makes.
   * A real wallet estimates and then adds headroom, and Shapes needs that headroom: the reentrancy
   * guard re-executes under the 63/64 rule, so a mint or compose sent at exactly the estimate can
   * run out of gas. Half again over the estimate, the same margin the site itself applies to an
   * auction bid.
   */
  const gasLimit = async (tx) => {
    const estimate = BigInt(await relay("eth_estimateGas", [{...tx, gas: undefined}]));
    return (estimate * 3n) / 2n;
  };

  await page.exposeFunction(BINDING, async (method, params) => {
    switch (method) {
      case "eth_requestAccounts":
        authorized = true;
        return [account.address];
      case "eth_accounts":
        return authorized ? [account.address] : [];
      case "eth_chainId":
        return toHex(chainId);
      case "net_version":
        return String(chainId);
      // The app asks the wallet to move to the deployment chain before every write. This wallet
      // only ever has that one chain, so the request is a no-op the app can succeed on.
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        return null;
      case "eth_sendTransaction": {
        const tx = params[0] ?? {};
        const hash = await wallet.sendTransaction({
          to: tx.to ?? undefined,
          data: tx.data ?? undefined,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : await gasLimit(tx),
        });
        sent.push(hash);
        return hash;
      }
      case "personal_sign":
        return account.signMessage({message: {raw: params[0]}});
      case "eth_signTypedData_v4":
        return account.signTypedData(
          typeof params[1] === "string" ? JSON.parse(params[1]) : params[1],
        );
      default:
        return relay(method, params);
    }
  });

  await page.addInitScript(installProvider, {binding: BINDING, info: PROVIDER_INFO});
  return {address: account.address, sent, lastTransaction: () => sent[sent.length - 1]};
}

export const TEST_WALLET_NAME = PROVIDER_INFO.name;
