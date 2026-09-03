import React from "react";
import type {Abi} from "viem";
import {useAccount, usePublicClient, useSwitchChain, useWaitForTransactionReceipt, useWriteContract} from "wagmi";
import {useConnectModal} from "@rainbow-me/rainbowkit";
import type {Deployment, LibraryName} from "../chain/abi";
import {CONTRACT_DOCS} from "../chain/contractDocs.generated";
import type {ContractDoc, DocFunction, DocMember} from "../chain/contractDocs";
import {C} from "./theme";
import {Section, addrUrl, txUrl, short} from "./ui";
import {parseArgs, parseEthValue} from "./contractArgs";
import {describeTxError} from "./errors";

/** Tab label, and the line saying where each address is discovered on chain. */
const META: Record<string, {shortName: string; note?: string}> = {
  Shapes: {shortName: "Shapes"},
  ShapeRenderer: {shortName: "Renderer", note: "Get the live address from Shapes.renderer()."},
  ShapeCollection: {shortName: "Collection", note: "Get the live address from Shapes.collection()."},
  ShapeAuctionHouse: {shortName: "Auction", note: "Discovered through Shapes.market(); it holds no authority over Shapes."},
  RecompositionOps: {shortName: "Recomposition", note: "Linked into Shapes at deploy time, with no setter."},
  AdminOps: {shortName: "Admin", note: "Linked into Shapes at deploy time, with no setter."},
  ComposeCompute: {shortName: "Compose", note: "Linked into Shapes at deploy time, with no setter."},
  GeometrySampling: {shortName: "Sampling", note: "Linked into Shapes at deploy time, with no setter."},
  InkGenes: {shortName: "Ink", note: "Linked into Shapes at deploy time, with no setter."},
};

const KIND_LABEL: Record<ContractDoc["kind"], string> = {
  token: "The protocol. Holds the reserve, the token and every protocol fact.",
  renderer: "Presentation. Read only by tokenURI.",
  collection: "Presentation. Read only by contractURI.",
  application: "An independent application. Calls Shapes and holds no authority over it.",
  library: "Delegatecall, no state, no authority.",
};

export function networkName(chainId: number): string {
  if (chainId === 1) return "Mainnet";
  if (chainId === 11155111) return "Sepolia";
  if (chainId === 31337) return "Local";
  return `Chain ${chainId}`;
}

/** A local chain has no block explorer, so it gets plain text instead of a dead link. */
export const explorerAddressUrl = (address: string, chainId: number): string | null =>
  chainId === 31337 ? null : addrUrl(address, chainId);

export const explorerTxUrl = (hash: string, chainId: number): string | null =>
  chainId === 31337 ? null : txUrl(hash, chainId);

/** Which deployment field records each contract's address. */
function recordedAddress(dep: Deployment, name: string): `0x${string}` | undefined {
  if (name === "Shapes") return dep.shapes;
  if (name === "ShapeRenderer") return dep.renderer;
  if (name === "ShapeCollection") return dep.collection;
  if (name === "ShapeAuctionHouse") return dep.auctionHouse;
  return dep.libraries?.[name as LibraryName] ?? undefined;
}

const isRead = (fn: DocFunction) => fn.stateMutability === "view" || fn.stateMutability === "pure";

/** Enum-backed parameters, which reach the ABI as a bare `uint8`. Keyed `function.parameter`;
 *  the array index is the enum value. Shown beside the input so a caller never has to look the
 *  index up in the source. */
const ENUM_MEMBERS: Record<string, readonly string[]> = {
  "setPointer.pointer": ["Positions", "Market"],
  "lockPointer.pointer": ["Positions", "Market"],
};

const enumHint = (fn: DocFunction, paramName: string): string | null => {
  const members = ENUM_MEMBERS[`${fn.name}.${paramName}`];
  return members ? members.map((member, value) => `${value} = ${member}`).join("  ") : null;
};

/** Decoded call output as text: bigints as decimal strings, everything structured as JSON. */
export function displayResult(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (value === undefined) return "()";
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

const mono: React.CSSProperties = {fontSize: 12, lineHeight: 1.6, color: C.ink, wordBreak: "break-word"};
const hint: React.CSSProperties = {fontSize: 11, lineHeight: 1.7, color: C.muted};
const panel: React.CSSProperties = {border: `1px solid ${C.border}`, padding: "14px 16px"};
const field: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "5px 8px",
  border: `1px solid ${C.border}`,
  background: C.page,
  color: C.ink,
  font: "inherit",
  fontSize: 12,
};

function actionButton(active: boolean): React.CSSProperties {
  return {
    border: `1px solid ${C.ink}`,
    background: active ? C.row : C.ink,
    color: active ? C.muted : C.page,
    padding: "5px 14px",
    fontSize: 11,
    letterSpacing: "0.08em",
    whiteSpace: "nowrap",
    cursor: active ? "default" : "pointer",
  };
}

function tabButton(on: boolean): React.CSSProperties {
  return {
    border: `1px solid ${on ? C.ink : C.border}`,
    background: on ? C.ink : "transparent",
    color: on ? C.page : C.bodyDim,
    padding: "4px 11px",
    fontSize: 11,
    whiteSpace: "nowrap",
    cursor: "pointer",
  };
}

function DevText({text, summary}: {text: string; summary: string}) {
  if (!text) return null;
  return (
    <details style={{marginTop: 8}}>
      <summary style={{...hint, cursor: "pointer"}}>{summary}</summary>
      <p style={{margin: "6px 0 0", fontSize: 12, lineHeight: 1.7, color: C.bodyDim, maxWidth: "72ch"}}>{text}</p>
    </details>
  );
}

function AddressLine({address, chainId, abbreviated}: {address: string; chainId: number; abbreviated?: boolean}) {
  const url = explorerAddressUrl(address, chainId);
  const text = abbreviated ? short(address) : address;
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" style={{...mono, color: C.ink}} title={address}>
      {text}
    </a>
  ) : (
    <span style={{...mono, color: C.bodyDim}} title={address}>
      {text}
    </span>
  );
}

/**
 * One function. A read runs through the public client on click, so the page issues no request
 * until the button is pressed; a write goes to the connected wallet and reports the transaction
 * through its receipt. Documentation-only functions (a library's storage-pointer surface) render
 * the same card with no form and no button.
 */
function FunctionCard({
  fn,
  address,
  chainId,
  callable,
}: {
  fn: DocFunction;
  address: `0x${string}` | undefined;
  chainId: number;
  callable: boolean;
}) {
  const [args, setArgs] = React.useState<Record<string, string>>({});
  const [ethValue, setEthValue] = React.useState("");
  const [reading, setReading] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const [queried, setQueried] = React.useState(false);
  const [inputError, setInputError] = React.useState<string | null>(null);
  const [readError, setReadError] = React.useState<string | null>(null);

  const publicClient = usePublicClient({chainId});
  const {isConnected} = useAccount();
  const {switchChainAsync} = useSwitchChain();
  const {writeContractAsync, data: hash, isPending, error: writeError, reset} = useWriteContract();
  const {isLoading: isConfirming, isSuccess} = useWaitForTransactionReceipt({hash});

  const read = isRead(fn);
  const payable = fn.stateMutability === "payable";
  const values = fn.inputs.map((input, i) => args[input.name || `arg${i}`] ?? "");

  const submit = async () => {
    if (!fn.abi || !address) return;
    setInputError(null);
    setReadError(null);
    const parsed = parseArgs(fn.inputs, values);
    if (!parsed.ok) {
      const input = fn.inputs[parsed.index];
      setInputError(`${input.name || input.type}: ${parsed.error}`);
      return;
    }
    let wei = 0n;
    if (payable) {
      const parsedValue = parseEthValue(ethValue);
      if (!parsedValue.ok) {
        setInputError(`value: ${parsedValue.error}`);
        return;
      }
      wei = parsedValue.value as bigint;
    }

    if (read) {
      setQueried(true);
      setReading(true);
      setResult(null);
      try {
        if (!publicClient) throw new Error("No RPC connection.");
        const out = await publicClient.readContract({
          address,
          abi: [fn.abi] as Abi,
          functionName: fn.name,
          args: parsed.values,
        } as Parameters<typeof publicClient.readContract>[0]);
        setResult(displayResult(out));
      } catch (e) {
        setReadError(describeTxError(e));
      } finally {
        setReading(false);
      }
      return;
    }

    reset();
    try {
      // Every write goes to the deployment chain; a wallet elsewhere is asked to switch first.
      await switchChainAsync({chainId});
      await writeContractAsync({
        address,
        abi: [fn.abi] as Abi,
        functionName: fn.name,
        args: parsed.values,
        chainId,
        ...(payable ? {value: wei} : {}),
      } as Parameters<typeof writeContractAsync>[0]);
    } catch {
      // Surfaced through `writeError` below, or ignored when the user dismissed the wallet.
    }
  };

  const busy = read ? reading : isPending || isConfirming;
  const buttonLabel = read
    ? reading
      ? "READING"
      : "CALL"
    : isPending
      ? "CONFIRM"
      : isConfirming
        ? "PENDING"
        : "WRITE";
  const txUrlOrNull = hash ? explorerTxUrl(hash, chainId) : null;
  const failure = inputError ?? readError ?? (writeError ? describeTxError(writeError) : null);

  return (
    <div style={{...panel, marginBottom: 8}}>
      <div style={{display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16}}>
        <div style={{flex: 1, minWidth: 0}}>
          <div style={{...mono, fontWeight: 500}}>
            {fn.name}
            {payable && <span style={{marginLeft: 8, ...hint}}>(payable)</span>}
            {!callable && <span style={{marginLeft: 8, ...hint}}>(documentation)</span>}
          </div>
          {fn.notice && (
            <p style={{margin: "5px 0 0", fontSize: 12, lineHeight: 1.7, color: C.body, maxWidth: "72ch"}}>
              {fn.notice}
            </p>
          )}
          <div style={{marginTop: 3, ...hint}}>
            {callable
              ? `returns: ${fn.outputs.map((o) => o.type).join(", ") || "void"}`
              : fn.signature}
          </div>
          <DevText text={fn.dev} summary="Developer notes" />

          {callable && fn.inputs.length > 0 && (
            <div style={{marginTop: 12}}>
              {fn.inputs.map((input, i) => {
                const key = input.name || `arg${i}`;
                const paramDoc = fn.params[input.name] ?? "";
                const members = enumHint(fn, input.name);
                return (
                  <div key={key} style={{marginBottom: 8}}>
                    <div style={{display: "flex", alignItems: "center", gap: 8}}>
                      <label
                        htmlFor={`${fn.signature}-${key}`}
                        title={`${key} (${input.type})`}
                        style={{width: 120, flexShrink: 0, ...hint, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"}}
                      >
                        {key} <span style={{color: C.faint}}>({input.type})</span>
                      </label>
                      <input
                        id={`${fn.signature}-${key}`}
                        value={args[key] ?? ""}
                        onChange={(e) => setArgs((prev) => ({...prev, [key]: e.target.value}))}
                        placeholder={members ?? input.type}
                        spellCheck={false}
                        style={field}
                      />
                      {members && <span style={{...hint, flexShrink: 0, whiteSpace: "nowrap"}}>{members}</span>}
                    </div>
                    {paramDoc && <p style={{margin: "3px 0 0 128px", ...hint, fontStyle: "italic"}}>{paramDoc}</p>}
                  </div>
                );
              })}
            </div>
          )}

          {callable && payable && (
            <div style={{marginTop: 8, display: "flex", alignItems: "center", gap: 8}}>
              <label htmlFor={`${fn.signature}-value`} style={{width: 120, flexShrink: 0, ...hint}}>
                value <span style={{color: C.faint}}>(ETH)</span>
              </label>
              <input
                id={`${fn.signature}-value`}
                value={ethValue}
                onChange={(e) => setEthValue(e.target.value)}
                placeholder="0.0"
                spellCheck={false}
                style={field}
              />
            </div>
          )}
        </div>

        {callable && (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || !address || (!read && !isConnected)}
            style={{...actionButton(busy), opacity: address && (read || isConnected) ? 1 : 0.4}}
          >
            {buttonLabel}
          </button>
        )}
      </div>

      {callable && read && queried && (
        <div style={{marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.ruleInner}`}}>
          {readError ? null : result !== null ? (
            <>
              <span style={hint}>Result</span>
              {Object.keys(fn.returns).length > 0 && (
                <span style={{marginLeft: 8, ...hint, fontStyle: "italic"}}>
                  ({Object.values(fn.returns).join(", ")})
                </span>
              )}
              <pre
                style={{
                  margin: "5px 0 0",
                  padding: "8px 10px",
                  maxHeight: 240,
                  overflow: "auto",
                  border: `1px solid ${C.ruleInner}`,
                  background: C.row,
                  fontSize: 11,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {result}
              </pre>
            </>
          ) : (
            <div style={hint}>{reading ? "Reading…" : "No result yet"}</div>
          )}
        </div>
      )}

      {callable && !read && (hash || isSuccess) && (
        <div style={{marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.ruleInner}`, ...hint}}>
          {hash && (
            <div>
              Transaction{" "}
              {txUrlOrNull ? (
                <a href={txUrlOrNull} target="_blank" rel="noreferrer" style={{color: C.muted}}>
                  {short(hash)}
                </a>
              ) : (
                <span>{short(hash)}</span>
              )}
            </div>
          )}
          {isSuccess && <div style={{marginTop: 3, color: C.ink}}>Transaction confirmed</div>}
        </div>
      )}

      {failure && (
        <div style={{marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.ruleInner}`, fontSize: 11, color: C.ink}}>
          {failure}
        </div>
      )}

      {callable && !read && !isConnected && <div style={{marginTop: 8, ...hint}}>Connect a wallet to write.</div>}
    </div>
  );
}

function MemberList({title, members}: {title: string; members: DocMember[]}) {
  if (members.length === 0) return null;
  return (
    <details style={{marginTop: 14}}>
      <summary style={{fontSize: 10, letterSpacing: "0.14em", color: C.muted, cursor: "pointer"}}>
        {title} ({members.length})
      </summary>
      <div style={{marginTop: 12}}>
        {members.map((m) => (
          <div key={`${title}:${m.signature}`} style={{...panel, marginBottom: 8}}>
            <div style={mono}>
              {m.name}({m.inputs.map((p) => `${p.type}${p.indexed ? " indexed" : ""} ${p.name}`.trim()).join(", ")})
            </div>
            {m.notice && (
              <p style={{margin: "5px 0 0", fontSize: 12, lineHeight: 1.7, color: C.body, maxWidth: "72ch"}}>{m.notice}</p>
            )}
            <DevText text={m.dev} summary="Developer notes" />
          </div>
        ))}
      </div>
    </details>
  );
}

/** The selected contract: its header, the read/write toggle, the search box and the cards. */
function ContractPanel({
  doc,
  dep,
  override,
  onOverride,
}: {
  doc: ContractDoc;
  dep: Deployment;
  override: string;
  onOverride: (value: string) => void;
}) {
  const [tab, setTab] = React.useState<"read" | "write">("read");
  const [search, setSearch] = React.useState("");

  const library = doc.kind === "library";
  const recorded = recordedAddress(dep, doc.name);
  const address = (/^0x[0-9a-fA-F]{40}$/.test(override.trim()) ? (override.trim() as `0x${string}`) : recorded);
  const note = META[doc.name]?.note;

  const reads = doc.functions.filter(isRead);
  const writes = doc.functions.filter((fn) => !isRead(fn));
  const shown = library ? doc.functions : tab === "read" ? reads : writes;
  const query = search.trim().toLowerCase();
  const filtered = query ? shown.filter((fn) => fn.name.toLowerCase().includes(query)) : shown;

  return (
    <div>
      <div style={{...panel, marginBottom: 16}}>
        <div style={{display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12}}>
          <div style={{flex: 1, minWidth: 240}}>
            <div style={{fontSize: 15, color: C.ink}}>{doc.name}</div>
            <p style={{margin: "4px 0 0", fontSize: 12, lineHeight: 1.7, color: C.body, maxWidth: "68ch"}}>
              {doc.description}
            </p>
            <p style={{margin: "3px 0 0", ...hint}}>{KIND_LABEL[doc.kind]}</p>
            <div style={{marginTop: 8}}>
              {address ? (
                <AddressLine address={address} chainId={dep.chainId} />
              ) : (
                <span style={hint}>Address not recorded for this deployment.</span>
              )}
            </div>
            {note && <p style={{margin: "4px 0 0", ...hint, fontStyle: "italic"}}>{note}</p>}
          </div>

          {!library && (
            <div style={{display: "flex", gap: 6}}>
              <button type="button" onClick={() => setTab("read")} style={tabButton(tab === "read")}>
                Read ({reads.length})
              </button>
              <button type="button" onClick={() => setTab("write")} style={tabButton(tab === "write")}>
                Write ({writes.length})
              </button>
            </div>
          )}
        </div>

        {!library && (!recorded || note) && (
          <div style={{marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.ruleInner}`}}>
            <label htmlFor={`${doc.name}-override`} style={hint}>
              Address override
            </label>
            <input
              id={`${doc.name}-override`}
              value={override}
              onChange={(e) => onOverride(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              style={{...field, width: "100%", marginTop: 4}}
            />
          </div>
        )}

        <div style={{marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.ruleInner}`}}>
          <label htmlFor={`${doc.name}-search`} style={{position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)"}}>
            Search functions
          </label>
          <input
            id={`${doc.name}-search`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search functions…"
            spellCheck={false}
            style={{...field, width: "100%"}}
          />
        </div>
      </div>

      {!address && !library ? (
        <div style={{padding: "28px 0", textAlign: "center", ...hint}}>
          Enter an address above to call this contract.
        </div>
      ) : filtered.length === 0 ? (
        <div style={{padding: "28px 0", textAlign: "center", ...hint}}>
          {query ? "No matching functions." : "No functions."}
        </div>
      ) : (
        filtered.map((fn) => (
          <FunctionCard
            key={fn.signature}
            fn={fn}
            address={address}
            chainId={dep.chainId}
            callable={!library && fn.abi !== undefined}
          />
        ))
      )}

      <MemberList title="EVENTS" members={doc.events} />
      <MemberList title="ERRORS" members={doc.errors} />
    </div>
  );
}

/**
 * Every deployed contract and linked library: its address, and every function, event and error
 * with the NatSpec the source carries. Generated from the Foundry artifacts
 * (`preview/scripts/genContractDocs.ts`), so it cannot drift from the ABI.
 */
export function ContractsView({dep}: {dep: Deployment}) {
  const [active, setActive] = React.useState(CONTRACT_DOCS[0].name);
  const [overrides, setOverrides] = React.useState<Record<string, string>>({});
  const {isConnected} = useAccount();
  const {openConnectModal} = useConnectModal();

  const current = CONTRACT_DOCS.find((c) => c.name === active) ?? CONTRACT_DOCS[0];
  const libraryIndex = CONTRACT_DOCS.findIndex((c) => c.kind === "library");

  return (
    <main>
      <Section title="CONTRACTS">
        <div style={{display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12}}>
          <p style={{margin: 0, fontSize: 15, lineHeight: 1.6, color: C.ink, maxWidth: "68ch"}}>
            Shapes is the protocol: it holds the reserve, the token and every protocol fact, and the
            libraries carry code it delegatecalls into its own storage. The renderer, the collection
            and the auction house are separate contracts at their own addresses.
          </p>
          <span style={{border: `1px solid ${C.border}`, padding: "3px 9px", ...hint}}>{networkName(dep.chainId)}</span>
        </div>
        <p style={{margin: "10px 0 0", ...hint, maxWidth: "68ch"}}>
          Reads run against chain {dep.chainId} when you press Call. Writes go to your connected
          wallet. Nothing is read until you ask for it.
        </p>
        {!isConnected && (
          <button
            type="button"
            onClick={() => openConnectModal?.()}
            style={{marginTop: 12, ...actionButton(false)}}
          >
            CONNECT WALLET
          </button>
        )}
      </Section>

      <Section title="DEPLOYED">
        {CONTRACT_DOCS.map((doc) => {
          const address = recordedAddress(dep, doc.name);
          return (
            <div
              key={doc.name}
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: 16,
                padding: "7px 0",
                borderBottom: `1px solid ${C.ruleInner}`,
              }}
            >
              <div style={{minWidth: 0}}>
                <span style={{fontSize: 13, color: C.ink}}>{doc.name}</span>
                <span style={{marginLeft: 8, ...hint}}>{doc.kind === "library" ? "library" : doc.kind}</span>
              </div>
              {address ? (
                <AddressLine address={address} chainId={dep.chainId} abbreviated />
              ) : (
                <span style={hint}>not recorded</span>
              )}
            </div>
          );
        })}
      </Section>

      <Section title="EXPLORE">
        <div style={{display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 16}}>
          {CONTRACT_DOCS.map((doc, i) => (
            <React.Fragment key={doc.name}>
              {i === libraryIndex && (
                <span style={{margin: "0 4px", fontSize: 10, letterSpacing: "0.14em", color: C.faint}}>
                  LIBRARIES
                </span>
              )}
              <button type="button" onClick={() => setActive(doc.name)} style={tabButton(active === doc.name)}>
                {META[doc.name]?.shortName ?? doc.name}
              </button>
            </React.Fragment>
          ))}
        </div>

        <ContractPanel
          key={current.name}
          doc={current}
          dep={dep}
          override={overrides[current.name] ?? ""}
          onOverride={(value) => setOverrides((prev) => ({...prev, [current.name]: value}))}
        />
      </Section>
    </main>
  );
}

export default ContractsView;
