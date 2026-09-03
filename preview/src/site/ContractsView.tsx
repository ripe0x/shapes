import React from "react";
import type {Abi, PublicClient} from "viem";
import type {Deployment, LibraryName} from "../chain/abi";
import {CONTRACT_DOCS} from "../chain/contractDocs.generated";
import type {ContractDoc, DocFunction, DocMember, DocParam} from "../chain/contractDocs";
import {C} from "./theme";
import {Section, addrUrl, txUrl, short} from "./ui";
import {parseArgs, parseValueWei} from "./contractArgs";
import {describeTxError} from "./errors";

/** A write request built from a row's form, executed by the host's wallet. */
export interface WriteRequest {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

const KIND_LABEL: Record<ContractDoc["kind"], string> = {
  token: "The protocol. Holds the reserve, the token and every protocol fact.",
  renderer: "Presentation. Read only by `tokenURI`.",
  collection: "Presentation. Read only by `contractURI`.",
  application: "An independent application. Calls Shapes and holds no authority over it.",
  library: "Linked into Shapes at deploy time and run under DELEGATECALL.",
};

/** Which deployment field records each contract's address. */
function addressOf(dep: Deployment, name: string): `0x${string}` | undefined {
  if (name === "Shapes") return dep.shapes;
  if (name === "ShapeRenderer") return dep.renderer;
  if (name === "ShapeCollection") return dep.collection;
  if (name === "ShapeAuctionHouse") return dep.auctionHouse;
  return dep.libraries?.[name as LibraryName] ?? undefined;
}

const isRead = (fn: DocFunction) => fn.stateMutability === "view" || fn.stateMutability === "pure";

/** `name(type name, type name)`, the form a reader recognises from the source. */
function displaySignature(name: string, params: DocParam[]): string {
  return `${name}(${params.map((p) => (p.name ? `${p.type} ${p.name}` : p.type)).join(", ")})`;
}

/** Decoded call output as text: bigints as decimal strings, everything structured as JSON. */
export function displayResult(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (value === undefined) return "()";
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
}

const mono: React.CSSProperties = {fontSize: 12, lineHeight: 1.6, color: C.ink, wordBreak: "break-word"};
const note: React.CSSProperties = {marginTop: 6, fontSize: 12, lineHeight: 1.7, color: C.body, maxWidth: "72ch"};
const devNote: React.CSSProperties = {...note, color: C.bodyDim};

function DevText({text, summary}: {text: string; summary: string}) {
  if (!text) return null;
  return (
    <details style={{marginTop: 8}}>
      <summary style={{fontSize: 11, color: C.muted, cursor: "pointer"}}>{summary}</summary>
      <p style={devNote}>{text}</p>
    </details>
  );
}

function CopyAddress({address, chainId}: {address: `0x${string}`; chainId: number}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div style={{marginTop: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, ...mono}}>
      <span title={address}>{address}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(address).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
        style={{border: `1px solid ${C.border}`, background: "transparent", color: C.bodyDim, padding: "3px 10px", fontSize: 11, cursor: "pointer"}}
      >
        {copied ? "COPIED" : "COPY"}
      </button>
      <a href={addrUrl(address, chainId)} target="_blank" rel="noreferrer" style={{fontSize: 11, color: C.muted}}>
        View on evm.now
      </a>
    </div>
  );
}

function MemberList({title, members}: {title: string; members: DocMember[]}) {
  if (members.length === 0) return null;
  return (
    <details style={{marginTop: 18, borderTop: `1px solid ${C.ruleInner}`, paddingTop: 12}}>
      <summary style={{fontSize: 11, letterSpacing: "0.14em", color: C.muted, cursor: "pointer"}}>
        {title} ({members.length})
      </summary>
      <div style={{marginTop: 12}}>
        {members.map((m) => (
          <div key={`${title}:${m.signature}`} style={{marginBottom: 14}}>
            <div style={mono}>{displaySignature(m.name, m.inputs)}</div>
            {m.notice && <p style={note}>{m.notice}</p>}
            <DevText text={m.dev} summary="Developer notes" />
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * One function. A read runs through the public client on click; a write goes to the connected
 * wallet. Nothing is read until the button is pressed, so the page makes no RPC call on render.
 */
function FunctionRow({
  fn,
  address,
  chainId,
  callable,
  publicClient,
  connected,
  onConnect,
  onWrite,
}: {
  fn: DocFunction;
  address: `0x${string}` | undefined;
  chainId: number;
  callable: boolean;
  publicClient: PublicClient | undefined;
  connected: boolean;
  onConnect: () => void;
  onWrite: (request: WriteRequest) => Promise<`0x${string}`>;
}) {
  const [args, setArgs] = React.useState<string[]>(() => fn.inputs.map(() => ""));
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<string | null>(null);
  const [hash, setHash] = React.useState<`0x${string}` | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [badField, setBadField] = React.useState<number | null>(null);

  const read = isRead(fn);
  const payable = fn.stateMutability === "payable";

  const run = async () => {
    if (!fn.abi || !address) return;
    setError(null);
    setResult(null);
    setHash(null);
    setBadField(null);
    const parsed = parseArgs(fn.inputs, args);
    if (!parsed.ok) {
      setBadField(parsed.index);
      setError(`${fn.inputs[parsed.index].name || fn.inputs[parsed.index].type}: ${parsed.error}`);
      return;
    }
    let wei = 0n;
    if (payable) {
      const parsedValue = parseValueWei(value);
      if (!parsedValue.ok) {
        setError(`value: ${parsedValue.error}`);
        return;
      }
      wei = parsedValue.value as bigint;
    }
    setBusy(true);
    try {
      if (read) {
        if (!publicClient) throw new Error("No RPC connection.");
        const out = await publicClient.readContract({
          address,
          abi: [fn.abi] as Abi,
          functionName: fn.name,
          args: parsed.values,
        } as Parameters<typeof publicClient.readContract>[0]);
        setResult(displayResult(out));
      } else {
        setHash(
          await onWrite({
            address,
            abi: [fn.abi] as Abi,
            functionName: fn.name,
            args: parsed.values,
            ...(payable ? {value: wei} : {}),
          }),
        );
      }
    } catch (e) {
      setError(describeTxError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{padding: "14px 0", borderTop: `1px solid ${C.ruleInner}`}}>
      <div style={mono}>{displaySignature(fn.name, fn.inputs)}</div>
      {fn.outputs.length > 0 && (
        <div style={{marginTop: 3, fontSize: 11, color: C.muted}}>
          returns {fn.outputs.map((o) => (o.name ? `${o.type} ${o.name}` : o.type)).join(", ")}
        </div>
      )}
      {fn.notice && <p style={note}>{fn.notice}</p>}
      <DevText text={fn.dev} summary="Developer notes" />

      {callable && (
        <div style={{marginTop: 10}}>
          {fn.inputs.map((input, i) => (
            <label key={`${input.name}-${i}`} style={{display: "block", marginBottom: 8, maxWidth: 560}}>
              <span style={{display: "block", fontSize: 10, letterSpacing: "0.08em", color: C.muted}}>
                {(input.name || `arg${i}`).toUpperCase()} · {input.type}
              </span>
              <input
                value={args[i] ?? ""}
                onChange={(e) => {
                  const next = [...args];
                  next[i] = e.target.value;
                  setArgs(next);
                }}
                spellCheck={false}
                style={{
                  width: "100%",
                  marginTop: 3,
                  padding: "6px 8px",
                  border: `1px solid ${badField === i ? C.ink : C.border}`,
                  background: C.page,
                  color: C.ink,
                  font: "inherit",
                  fontSize: 12,
                }}
              />
            </label>
          ))}
          {payable && (
            <label style={{display: "block", marginBottom: 8, maxWidth: 560}}>
              <span style={{display: "block", fontSize: 10, letterSpacing: "0.08em", color: C.muted}}>
                VALUE · wei
              </span>
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                spellCheck={false}
                placeholder="0"
                style={{width: "100%", marginTop: 3, padding: "6px 8px", border: `1px solid ${C.border}`, background: C.page, color: C.ink, font: "inherit", fontSize: 12}}
              />
            </label>
          )}
          <button
            type="button"
            disabled={busy || !address || (!read && !connected)}
            onClick={() => (!read && !connected ? onConnect() : void run())}
            style={{
              border: `1px solid ${C.ink}`,
              background: busy ? C.row : C.ink,
              color: busy ? C.muted : C.page,
              padding: "5px 16px",
              fontSize: 11,
              letterSpacing: "0.08em",
              cursor: busy ? "default" : "pointer",
              opacity: address ? 1 : 0.4,
            }}
          >
            {busy ? (read ? "READING" : "CONFIRM IN WALLET") : read ? "CALL" : "SEND"}
          </button>
          {!read && !connected && (
            <button
              type="button"
              onClick={onConnect}
              style={{marginLeft: 10, border: `1px solid ${C.border}`, background: "transparent", color: C.bodyDim, padding: "5px 14px", fontSize: 11, cursor: "pointer"}}
            >
              CONNECT WALLET
            </button>
          )}
        </div>
      )}

      {result !== null && (
        <pre
          style={{
            margin: "10px 0 0",
            padding: "10px 12px",
            maxHeight: 260,
            overflow: "auto",
            background: C.row,
            border: `1px solid ${C.ruleInner}`,
            fontSize: 11,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {result}
        </pre>
      )}
      {hash && (
        <div style={{marginTop: 10, fontSize: 11, color: C.muted}}>
          Sent ·{" "}
          <a href={txUrl(hash, chainId)} target="_blank" rel="noreferrer" style={{color: C.muted}}>
            {short(hash)}
          </a>
        </div>
      )}
      {error && <div style={{marginTop: 10, fontSize: 11, color: C.ink}}>{error}</div>}
    </div>
  );
}

function ContractSection({
  doc,
  dep,
  publicClient,
  connected,
  onConnect,
  onWrite,
}: {
  doc: ContractDoc;
  dep: Deployment;
  publicClient: PublicClient | undefined;
  connected: boolean;
  onConnect: () => void;
  onWrite: (request: WriteRequest) => Promise<`0x${string}`>;
}) {
  const address = addressOf(dep, doc.name);
  const library = doc.kind === "library";
  const reads = doc.functions.filter(isRead);
  const writes = doc.functions.filter((fn) => !isRead(fn));

  const group = (title: string, functions: DocFunction[]) =>
    functions.length === 0 ? null : (
      <div style={{marginTop: 22}}>
        <div style={{fontSize: 10, letterSpacing: "0.14em", color: C.muted}}>
          {title} ({functions.length})
        </div>
        {functions.map((fn) => (
          <FunctionRow
            key={`${title}:${fn.signature}`}
            fn={fn}
            address={address}
            chainId={dep.chainId}
            callable={!library && fn.abi !== undefined}
            publicClient={publicClient}
            connected={connected}
            onConnect={onConnect}
            onWrite={onWrite}
          />
        ))}
      </div>
    );

  return (
    <Section title={doc.name.toUpperCase()}>
      <p style={{margin: 0, fontSize: 15, lineHeight: 1.6, color: C.ink, maxWidth: "68ch"}}>{doc.description}</p>
      <p style={{margin: "8px 0 0", fontSize: 12, color: C.muted, maxWidth: "68ch"}}>{KIND_LABEL[doc.kind]}</p>
      {address ? (
        <CopyAddress address={address} chainId={dep.chainId} />
      ) : (
        <div style={{marginTop: 10, fontSize: 12, color: C.muted}}>Address not recorded for this deployment.</div>
      )}
      <DevText text={doc.dev} summary="Design notes" />

      {library ? group("FUNCTIONS", doc.functions) : (
        <>
          {group("READ", reads)}
          {group("WRITE", writes)}
        </>
      )}

      <MemberList title="EVENTS" members={doc.events} />
      <MemberList title="ERRORS" members={doc.errors} />
    </Section>
  );
}

/**
 * Every deployed contract and linked library: its address, and every function, event and error
 * with the NatSpec the source carries. Generated from the Foundry artifacts
 * (`preview/scripts/genContractDocs.ts`), so it cannot drift from the ABI.
 */
export function ContractsView({
  dep,
  publicClient,
  connected,
  onConnect,
  onWrite,
}: {
  dep: Deployment;
  publicClient: PublicClient | undefined;
  connected: boolean;
  onConnect: () => void;
  onWrite: (request: WriteRequest) => Promise<`0x${string}`>;
}) {
  const contracts = CONTRACT_DOCS.filter((c) => c.kind !== "library");
  const libraries = CONTRACT_DOCS.filter((c) => c.kind === "library");
  const props = {dep, publicClient, connected, onConnect, onWrite};

  return (
    <main>
      <Section title="CONTRACTS">
        <p style={{margin: 0, fontSize: 15, lineHeight: 1.6, color: C.ink, maxWidth: "68ch"}}>
          Shapes is the protocol: it holds the reserve, the token and every protocol fact, and the
          libraries below carry code it delegatecalls into its own storage. The renderer, the
          collection and the auction house are separate contracts at their own addresses.
        </p>
        <p style={{margin: "10px 0 0", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "68ch"}}>
          Reads run against chain {dep.chainId} when you press Call. Writes go to your connected
          wallet. Nothing is read until you ask for it.
        </p>
      </Section>

      {contracts.map((doc) => (
        <ContractSection key={doc.name} doc={doc} {...props} />
      ))}

      <Section title="LIBRARIES">
        <p style={{margin: 0, fontSize: 15, lineHeight: 1.6, color: C.ink, maxWidth: "68ch"}}>
          Delegatecall, no state, no authority.
        </p>
        <p style={{margin: "10px 0 0", fontSize: 12, lineHeight: 1.7, color: C.muted, maxWidth: "68ch"}}>
          Each address is linked into Shapes at deploy time and has no setter. Their functions run
          in Shapes&apos;s storage and are listed here as documentation: most take a storage-struct
          pointer as their first argument, which no external caller can supply, so they are reachable
          only through Shapes.
        </p>
      </Section>

      {libraries.map((doc) => (
        <ContractSection key={doc.name} doc={doc} {...props} />
      ))}
    </main>
  );
}

export default ContractsView;
