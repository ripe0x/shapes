import type {AbiFunction, AbiParameter} from "viem";

/** Role a contract plays in the deployment. Drives the ordering and the copy on `/contracts`. */
export type ContractKind = "token" | "renderer" | "collection" | "application" | "library";

export interface DocParam {
  name: string;
  /** Canonical ABI type, tuples expanded (`(uint256,uint256[])[]`). */
  type: string;
  indexed?: boolean;
}

export interface DocFunction {
  name: string;
  /** Canonical signature, the key NatSpec is indexed by (`compose(uint256,uint256[])`). */
  signature: string;
  stateMutability: "view" | "pure" | "nonpayable" | "payable" | "";
  inputs: DocParam[];
  outputs: DocParam[];
  notice: string;
  dev: string;
  /** Per-parameter `@param` text, keyed by parameter name. Empty when the source declares none. */
  params: Record<string, string>;
  /** Per-return `@return` text, keyed by return name (`_0` for an unnamed one). */
  returns: Record<string, string>;
  /** The ABI entry to call with. Absent for a library function whose storage-pointer parameters
   *  keep it out of the ABI; such a function is documentation only. */
  abi?: AbiFunction;
}

export interface DocMember {
  name: string;
  signature: string;
  inputs: DocParam[];
  notice: string;
  dev: string;
}

export interface ContractDoc {
  name: string;
  kind: ContractKind;
  /** The contract's `@notice`, falling back to its `@title`. */
  description: string;
  /** The contract's `@dev`. Empty when it has none. */
  dev: string;
  functions: DocFunction[];
  events: DocMember[];
  errors: DocMember[];
}

/** One entry of solc's `devdoc`/`userdoc` method, event or error maps. */
interface NatSpecEntry {
  notice?: string;
  details?: string;
  params?: Record<string, string>;
  returns?: Record<string, string>;
}

interface NatSpecDoc {
  title?: string;
  notice?: string;
  details?: string;
  methods?: Record<string, NatSpecEntry>;
  events?: Record<string, NatSpecEntry>;
  errors?: Record<string, NatSpecEntry | NatSpecEntry[]>;

}

/** The fields of a Foundry artifact this transform reads. */
export interface Artifact {
  abi: readonly unknown[];
  rawMetadata?: unknown;
  metadata?: unknown;
  methodIdentifiers?: Record<string, string>;
}

/** Collapses NatSpec's wrapped continuation lines into one paragraph. */
export function oneParagraph(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

/** NatSpec's `@param`/`@return` map, each entry collapsed to one paragraph, keys sorted. */
function textMap(entries: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(entries ?? {}).sort()) {
    const text = oneParagraph(entries![key]);
    if (text) out[key] = text;
  }
  return out;
}

/** Canonical ABI type of one parameter, tuples expanded to their component list. */
export function typeOf(param: AbiParameter): string {
  const components = (param as {components?: readonly AbiParameter[]}).components;
  if (!components) return param.type;
  const inner = `(${components.map(typeOf).join(",")})`;
  // A tuple array's `type` is "tuple[]" / "tuple[2]"; keep whatever follows the base word.
  return inner + param.type.slice("tuple".length);
}

function paramsOf(params: readonly AbiParameter[] | undefined): DocParam[] {
  return (params ?? []).map((p) => {
    const indexed = (p as {indexed?: boolean}).indexed;
    return {
      name: p.name ?? "",
      type: typeOf(p),
      ...(indexed === undefined ? {} : {indexed}),
    };
  });
}

/** ABI parameters with `internalType` dropped: viem ignores it and it doubles the generated file. */
function abiParams(params: readonly AbiParameter[] | undefined): AbiParameter[] {
  return (params ?? []).map((p) => {
    const components = (p as {components?: readonly AbiParameter[]}).components;
    return {
      name: p.name ?? "",
      type: p.type,
      ...(components ? {components: abiParams(components)} : {}),
    } as AbiParameter;
  });
}

function signatureOf(name: string, params: readonly AbiParameter[] | undefined): string {
  return `${name}(${(params ?? []).map(typeOf).join(",")})`;
}

/**
 * Parses the artifact's solc metadata. Foundry's typed `metadata` field drops the contract-level
 * `@title`/`@notice`, so `rawMetadata` (the verbatim JSON string) is read first. Either field may
 * arrive as a string or as an already-parsed object.
 */
function metadataOutput(artifact: Artifact): {devdoc: NatSpecDoc; userdoc: NatSpecDoc} {
  const parse = (value: unknown): Record<string, unknown> | null => {
    if (typeof value === "string") {
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  };
  for (const candidate of [artifact.rawMetadata, artifact.metadata]) {
    const parsed = parse(candidate);
    const output = parsed?.output as {devdoc?: NatSpecDoc; userdoc?: NatSpecDoc} | undefined;
    if (output?.devdoc?.title || output?.userdoc?.notice) {
      return {devdoc: output.devdoc ?? {}, userdoc: output.userdoc ?? {}};
    }
  }
  const fallback = parse(artifact.rawMetadata) ?? parse(artifact.metadata);
  const output = (fallback?.output ?? {}) as {devdoc?: NatSpecDoc; userdoc?: NatSpecDoc};
  return {devdoc: output.devdoc ?? {}, userdoc: output.userdoc ?? {}};
}

/** solc records an error's docs as either one entry or an array of them (one per overload). */
function firstEntry(value: NatSpecEntry | NatSpecEntry[] | undefined): NatSpecEntry {
  return (Array.isArray(value) ? value[0] : value) ?? {};
}

function bySignature(a: {signature: string}, b: {signature: string}): number {
  return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
}

const documented = (member: {notice: string; dev: string}) => member.notice.length > 0 || member.dev.length > 0;

/**
 * One entry per canonical signature. A member reachable through two inheritance or library paths
 * is listed once per path in the ABI, and only one of those carries the NatSpec, so the documented
 * entry wins and position follows the first occurrence.
 */
function dedupe<T extends {signature: string; notice: string; dev: string}>(members: T[]): T[] {
  const kept = new Map<string, T>();
  for (const member of members) {
    const existing = kept.get(member.signature);
    if (!existing || (!documented(existing) && documented(member))) kept.set(member.signature, member);
  }
  return [...kept.values()];
}

/**
 * One contract's documentation from its Foundry artifact: the ABI for the callable surface and
 * the solc NatSpec maps for the prose. A library's public functions that take a storage pointer
 * are absent from the ABI but present in `methodIdentifiers`; those are carried as
 * documentation-only entries, since they are reachable only through the contract that links them.
 */
export function contractDocFromArtifact(name: string, kind: ContractKind, artifact: Artifact): ContractDoc {
  const {devdoc, userdoc} = metadataOutput(artifact);
  const abi = artifact.abi as readonly {type: string; name?: string; stateMutability?: string; inputs?: AbiParameter[]; outputs?: AbiParameter[]}[];

  const functions: DocFunction[] = [];
  const seen = new Set<string>();
  for (const item of abi) {
    if (item.type !== "function" || !item.name) continue;
    const signature = signatureOf(item.name, item.inputs);
    seen.add(signature);
    functions.push({
      name: item.name,
      signature,
      stateMutability: (item.stateMutability ?? "nonpayable") as DocFunction["stateMutability"],
      inputs: paramsOf(item.inputs),
      outputs: paramsOf(item.outputs),
      notice: oneParagraph(userdoc.methods?.[signature]?.notice),
      dev: oneParagraph(devdoc.methods?.[signature]?.details),
      params: textMap(devdoc.methods?.[signature]?.params),
      returns: textMap(devdoc.methods?.[signature]?.returns),
      abi: {
        type: "function",
        name: item.name,
        inputs: abiParams(item.inputs),
        outputs: abiParams(item.outputs),
        stateMutability: (item.stateMutability ?? "nonpayable") as AbiFunction["stateMutability"],
      },
    });
  }

  // A library's storage-pointer surface: in methodIdentifiers and in NatSpec, never in the ABI.
  for (const signature of Object.keys(artifact.methodIdentifiers ?? {})) {
    if (seen.has(signature)) continue;
    functions.push({
      name: signature.slice(0, signature.indexOf("(")),
      signature,
      stateMutability: "",
      inputs: [],
      outputs: [],
      notice: oneParagraph(userdoc.methods?.[signature]?.notice),
      dev: oneParagraph(devdoc.methods?.[signature]?.details),
      params: textMap(devdoc.methods?.[signature]?.params),
      returns: textMap(devdoc.methods?.[signature]?.returns),
    });
  }

  type EntryMap = Record<string, NatSpecEntry | NatSpecEntry[]>;
  const members = (kindOf: "event" | "error", docs: {u?: EntryMap; d?: EntryMap}): DocMember[] => {
    const entries = abi
      .filter((item) => item.type === kindOf && item.name)
      .map((item) => {
        const signature = signatureOf(item.name!, item.inputs);
        return {
          name: item.name!,
          signature,
          inputs: paramsOf(item.inputs),
          notice: oneParagraph(firstEntry(docs.u?.[signature]).notice),
          dev: oneParagraph(firstEntry(docs.d?.[signature]).details),
        };
      });
    return dedupe(entries.sort(bySignature));
  };

  return {
    name,
    kind,
    description: oneParagraph(userdoc.notice) || oneParagraph(devdoc.title) || name,
    dev: oneParagraph(devdoc.details),
    functions: dedupe(functions.sort(bySignature)),
    events: members("event", {u: userdoc.events, d: devdoc.events}),
    errors: members("error", {u: userdoc.errors as Record<string, NatSpecEntry> | undefined, d: devdoc.errors}),
  };
}
