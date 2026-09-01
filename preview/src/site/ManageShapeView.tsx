import React from "react";
import {hexToBytes, type Hex, type PublicClient} from "viem";
import {DENOMINATIONS, shapeLensAbi, type Deployment} from "../chain/abi";
import {CANONICAL, renderShape} from "../canonical/render";
import {
  renderSampledShape,
  sampleSplitChild,
  type LastMergeDonors,
  type SampleDonor,
} from "../canonical/sampling";
import {C, label} from "./theme";
import {Art, Modal, Section, short} from "./ui";
import type {SiteData, SiteToken} from "./data";
import {buildComposeResultPreview} from "./composePreview";

type ManageAction = "split" | "decompose" | "redeem" | "sacrifice";

interface ComposeRecordPreview {
  survivorDenominationIndex: number;
  survivorInkGene: number;
  survivorModules: Hex;
  inputs: {
    id: bigint;
    seed: Hex;
    denominationIndex: number;
    inkGene: number;
    modules: Hex;
  }[];
}

interface ResultCard {
  id: bigint | null;
  image: string;
  value: string;
  eyebrow: string;
  identity: string;
}

const svgData = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;

export function ManageShapeView({
  data,
  dep,
  publicClient,
  address,
  tokenId,
  busy,
  txErr,
  onBack,
  onStartCompose,
  onSplit,
  onDecompose,
  onRedeem,
  onSacrifice,
}: {
  data: SiteData | null;
  dep: Deployment;
  publicClient: PublicClient | undefined;
  address: `0x${string}` | undefined;
  tokenId: bigint;
  busy: string | null;
  txErr: {op: string; text: string} | null;
  onBack: () => void;
  onStartCompose: (tokenId: bigint) => void;
  onSplit: (token: SiteToken) => void;
  onDecompose: (token: SiteToken) => void;
  onRedeem: (token: SiteToken) => void;
  onSacrifice: (token: SiteToken) => void;
}) {
  const token = data?.tokens.find((candidate) => candidate.id === tokenId) ?? null;
  const owned = !!token && !!address && token.owner.toLowerCase() === address.toLowerCase();
  const [action, setAction] = React.useState<ManageAction | null>(null);
  const [confirming, setConfirming] = React.useState<"split" | "redeem" | "sacrifice" | null>(null);
  const [composeRecord, setComposeRecord] = React.useState<ComposeRecordPreview | null>(null);
  const [recordUnavailable, setRecordUnavailable] = React.useState(false);
  const [splitPreviews, setSplitPreviews] = React.useState<ResultCard[] | null>(null);
  const [splitPreviewUnavailable, setSplitPreviewUnavailable] = React.useState(false);

  React.useEffect(() => {
    setAction(null);
    setConfirming(null);
  }, [tokenId]);

  const candidates = React.useMemo(
    () =>
      owned && token && token.di >= 0
        ? (data?.tokens ?? []).filter(
            (candidate) =>
              candidate.di === token.di &&
              candidate.id !== token.id &&
              candidate.owner.toLowerCase() === address!.toLowerCase(),
          )
        : [],
    [address, data, owned, token],
  );
  React.useEffect(() => {
    let cancelled = false;
    setComposeRecord(null);
    setRecordUnavailable(false);
    if (!publicClient || !token || token.composeDepth === 0) return;

    void publicClient
      .readContract({
        address: dep.lens,
        abi: shapeLensAbi,
        functionName: "composeRecordAt",
        args: [token.id, BigInt(token.composeDepth - 1)],
      })
      .then((record) => {
        if (cancelled) return;
        setComposeRecord({
          survivorDenominationIndex: record.survivorDenominationIndex,
          survivorInkGene: record.survivorInkGene,
          survivorModules: record.survivorModules,
          inputs: record.inputs.map((input) => ({
            id: input.id,
            seed: input.seed,
            denominationIndex: input.denominationIndex,
            inkGene: input.inkGene,
            modules: input.modules,
          })),
        });
      })
      .catch(() => {
        if (!cancelled) setRecordUnavailable(true);
      });

    return () => {
      cancelled = true;
    };
  }, [dep.lens, publicClient, token]);

  const canSplit = !!token && token.di > 0;
  const splitDenominationIndex = canSplit ? token.di - 1 : -1;
  const splitRatio = canSplit
    ? Number(token.backing / DENOMINATIONS[splitDenominationIndex].wei)
    : 0;

  React.useEffect(() => {
    let cancelled = false;
    setSplitPreviews(null);
    setSplitPreviewUnavailable(false);
    if (action !== "split" || !publicClient || !token || !canSplit) return;
    if (token.composeDepth > 0 && !composeRecord) {
      if (recordUnavailable) setSplitPreviewUnavailable(true);
      return;
    }

    void (async () => {
      const state = await publicClient.readContract({
        address: dep.lens,
        abi: shapeLensAbi,
        functionName: "shapeState",
        args: [token.id],
      });
      const stateModules = hexToBytes(state.modules);
      const parent: SampleDonor = {
        seed: BigInt(state.seed),
        denomIndex: state.denominationIndex,
        inkGene: state.inkGene,
        modules: stateModules.length > 0 ? stateModules : undefined,
      };
      let lastMerge: LastMergeDonors | undefined;
      if (composeRecord) {
        lastMerge = {
          survivor: {
            seed: token.seed,
            denomIndex: composeRecord.survivorDenominationIndex,
            inkGene: composeRecord.survivorInkGene,
            modules: hexToBytes(composeRecord.survivorModules),
          },
          inputs: composeRecord.inputs.map((input) => ({
            tokenId: input.id,
            seed: BigInt(input.seed),
            denomIndex: input.denominationIndex,
            inkGene: input.inkGene,
            modules: hexToBytes(input.modules),
          })),
        };
      }

      return Array.from({length: splitRatio}, (_, index) => {
        const modules = sampleSplitChild(
          parent,
          splitDenominationIndex,
          index,
          CANONICAL,
          lastMerge,
        );
        return {
          id: null,
          image: svgData(
            renderSampledShape(modules, splitDenominationIndex, 0n, token.inkGene),
          ),
          value: `${DENOMINATIONS[splitDenominationIndex].label} ETH`,
          eyebrow: `NEW SHAPE ${String.fromCharCode(65 + index)}`,
          identity: "ID assigned after confirmation",
        } satisfies ResultCard;
      });
    })()
      .then((previews) => {
        if (!cancelled) setSplitPreviews(previews);
      })
      .catch(() => {
        if (!cancelled) setSplitPreviewUnavailable(true);
      });

    return () => {
      cancelled = true;
    };
  }, [action, canSplit, composeRecord, dep.lens, publicClient, recordUnavailable, splitDenominationIndex, splitRatio, token]);

  if (!token) {
    return (
      <main>
        <ManageBack tokenId={tokenId} onBack={onBack} />
        <Section title="MANAGE SHAPE">
          <p style={{margin: 0, color: C.bodyDim, fontSize: 13, lineHeight: 1.7}}>
            Shape #{tokenId.toString()} is no longer live and cannot be managed.
          </p>
        </Section>
      </main>
    );
  }

  if (token.di < 0) {
    return (
      <main>
        <ManageBack tokenId={tokenId} onBack={onBack} />
        <Section title="BLACK SHAPE" pad="36px 48px 44px 32px">
          <ManageIdentity token={token} owned={owned} />
          <p style={{margin: "26px 0 0", maxWidth: "60ch", color: C.bodyDim, fontSize: 13, lineHeight: 1.75}}>
            This Shape has already been sacrificed. It remains transferable, but its backing is
            permanently unredeemable and no lifecycle actions remain.
          </p>
        </Section>
      </main>
    );
  }

  const isComplete = token.meta.attributes.some(
    (attribute) => attribute.trait_type === "Complete" && attribute.value.toLowerCase() === "true",
  );
  const sacrificeEligible = token.di === DENOMINATIONS.length - 1 && isComplete;
  const nextDenomination = token.di < DENOMINATIONS.length - 1 ? DENOMINATIONS[token.di + 1] : null;
  const composeInputsNeeded = nextDenomination
    ? Number(nextDenomination.wei / token.backing) - 1
    : 0;
  const canCompose = !!nextDenomination && candidates.length >= composeInputsNeeded;
  const ownerBlock = !address
    ? "Connect the owning wallet to use this action."
    : !owned
      ? `Only ${short(token.owner)} can manage this Shape.`
      : null;

  const availability = (allowed: boolean, unavailable: string) =>
    ownerBlock ?? (allowed ? null : unavailable);

  const options: {
    id: ManageAction | "compose";
    protocol: string;
    title: string;
    description: string;
    consequence: string;
    unavailable: string | null;
  }[] = [
    {
      id: "compose",
      protocol: "COMPOSE",
      title: "Grow this Shape",
      description: `Compose #${token.id.toString()} with matching Shapes you own. It keeps its ID and becomes more valuable.`,
      consequence: "Newest grow can be undone",
      unavailable: availability(
        canCompose,
        nextDenomination
          ? `You need ${composeInputsNeeded} other ${DENOMINATIONS[token.di].label} ETH Shapes to reach ${nextDenomination.label} ETH.`
          : "This Shape is already at the highest denomination.",
      ),
    },
    {
      id: "split",
      protocol: "SPLIT",
      title: "Break into smaller Shapes",
      description: canSplit
        ? `Destroy #${token.id.toString()} and create ${splitRatio} new ${DENOMINATIONS[splitDenominationIndex].label} ETH Shapes.`
        : "Create new, smaller-denomination Shapes from this one.",
      consequence: "Permanent · new IDs",
      unavailable: availability(canSplit, "This is already the smallest denomination."),
    },
    {
      id: "decompose",
      protocol: "DECOMPOSE",
      title: "Undo the last grow",
      description: `Return #${token.id.toString()} to its previous state and restore the Shapes it most recently absorbed.`,
      consequence: "Original IDs return",
      unavailable: availability(token.composeDepth > 0, "Available after this Shape has been composed."),
    },
    {
      id: "redeem",
      protocol: "REDEEM",
      title: "Redeem its ETH",
      description: `Destroy #${token.id.toString()} and receive exactly ${DENOMINATIONS[token.di].label} ETH.`,
      consequence: "Permanent · token is burned",
      unavailable: ownerBlock,
    },
    {
      id: "sacrifice",
      protocol: "SACRIFICE",
      title: "Make a Black Shape",
      description: "Permanently remove the backing while keeping the token as a Black Shape.",
      consequence: "Permanent · ETH is unspendable",
      unavailable: availability(
        sacrificeEligible,
        `Requires a complete ${DENOMINATIONS[DENOMINATIONS.length - 1].label} ETH Shape.`,
      ),
    },
  ];

  const selectAction = (next: ManageAction) => {
    setAction(next);
    setConfirming(null);
    window.scrollTo({top: 0, behavior: "smooth"});
  };

  const actionError = action && txErr?.op === action ? txErr.text : null;

  return (
    <main>
      <ManageBack tokenId={tokenId} onBack={onBack} />
      <Section title="MANAGE SHAPE" pad="32px 48px 38px 32px">
        <ManageIdentity token={token} owned={owned} />
      </Section>

      {action === null ? (
        <Section title="ACTIONS" pad="30px 48px 48px 32px" last>
          <div style={{maxWidth: 860}}>
            <div style={{fontSize: 24, lineHeight: 1.3}}>What do you want to do?</div>
            <p style={{margin: "10px 0 26px", maxWidth: "64ch", color: C.muted, fontSize: 12, lineHeight: 1.7}}>
              Choose an outcome first. You will review the exact identity, artwork, and ETH
              consequences before your wallet is asked to confirm anything.
            </p>
            <div className="manage-action-grid">
              {options.map((option) => (
                <ActionCard
                  key={option.id}
                  {...option}
                  onClick={() =>
                    option.id === "compose" ? onStartCompose(token.id) : selectAction(option.id)
                  }
                />
              ))}
            </div>
          </div>
        </Section>
      ) : (
        <Section
          title={options.find((option) => option.id === action)!.protocol}
          pad="28px 48px 52px 32px"
          last
        >
          <button
            type="button"
            className="btn-ghost"
            onClick={() => setAction(null)}
            disabled={!!busy}
            style={{marginBottom: 28, color: C.muted, fontSize: 11, letterSpacing: "0.12em"}}
          >
            ← ALL ACTIONS
          </button>

          {action === "split" && (
            <SplitFlow
              token={token}
              previews={splitPreviews}
              previewUnavailable={splitPreviewUnavailable}
              ratio={splitRatio}
              childDenominationIndex={splitDenominationIndex}
              busy={busy}
              onConfirm={() => setConfirming("split")}
            />
          )}

          {action === "decompose" && (
            <DecomposeFlow
              token={token}
              record={composeRecord}
              unavailable={recordUnavailable}
              busy={busy}
              onSubmit={() => onDecompose(token)}
            />
          )}

          {action === "redeem" && (
            <RedeemFlow token={token} busy={busy} onConfirm={() => setConfirming("redeem")} />
          )}

          {action === "sacrifice" && (
            <SacrificeFlow token={token} busy={busy} onConfirm={() => setConfirming("sacrifice")} />
          )}

          {actionError && (
            <p style={{margin: "20px 0 0", maxWidth: "60ch", color: C.muted, fontSize: 12, lineHeight: 1.7}}>
              {actionError}
            </p>
          )}
        </Section>
      )}

      {confirming === "split" && (
        <Modal title="SPLIT IS PERMANENT" onCancel={() => setConfirming(null)}>
          <p style={{margin: "0 0 12px", color: C.ink, fontSize: 14, lineHeight: 1.7}}>
            Shape #{token.id.toString()} will be burned. {splitRatio} new Shapes will be created
            with the exact artwork shown, and their IDs will be assigned onchain.
          </p>
          <p style={{margin: "0 0 24px", color: C.muted, fontSize: 12, lineHeight: 1.7}}>
            Composing those Shapes later will not restore #{token.id.toString()} or its artwork.
            The total ETH backing remains unchanged.
          </p>
          <ConfirmButtons
            busy={busy === "split"}
            confirmLabel={`Split #${token.id.toString()} into ${splitRatio} new Shapes`}
            onConfirm={() => {
              setConfirming(null);
              onSplit(token);
            }}
            onCancel={() => setConfirming(null)}
          />
        </Modal>
      )}

      {confirming === "redeem" && (
        <Modal title="REDEEM IS PERMANENT" onCancel={() => setConfirming(null)}>
          <p style={{margin: "0 0 12px", color: C.ink, fontSize: 14, lineHeight: 1.7}}>
            Shape #{token.id.toString()} will be burned. Exactly {DENOMINATIONS[token.di].label} ETH
            will be sent to {short(token.owner)}.
          </p>
          <p style={{margin: "0 0 24px", color: C.muted, fontSize: 12, lineHeight: 1.7}}>
            The token, its artwork, and its remaining compose history will no longer be live.
          </p>
          <ConfirmButtons
            busy={busy === "redeem"}
            confirmLabel={`Redeem #${token.id.toString()}`}
            onConfirm={() => {
              setConfirming(null);
              onRedeem(token);
            }}
            onCancel={() => setConfirming(null)}
          />
        </Modal>
      )}

      {confirming === "sacrifice" && (
        <Modal title="SACRIFICE IS PERMANENT" onCancel={() => setConfirming(null)}>
          <p style={{margin: "0 0 12px", color: C.ink, fontSize: 14, lineHeight: 1.7}}>
            Shape #{token.id.toString()} will remain as a Black Shape, but its entire
            {` ${DENOMINATIONS[token.di].label} ETH`} backing will be sent to an unspendable address.
          </p>
          <p style={{margin: "0 0 24px", color: C.muted, fontSize: 12, lineHeight: 1.7}}>
            It can never be redeemed, split, composed, or restored. No person can recover the ETH.
          </p>
          <ConfirmButtons
            busy={busy === "sacrifice"}
            confirmLabel={`Sacrifice #${token.id.toString()}`}
            onConfirm={() => {
              setConfirming(null);
              onSacrifice(token);
            }}
            onCancel={() => setConfirming(null)}
          />
        </Modal>
      )}
    </main>
  );
}

function ManageBack({tokenId, onBack}: {tokenId: bigint; onBack: () => void}) {
  return (
    <div style={{padding: "20px 48px", borderBottom: `1px solid ${C.rule}`, fontSize: 11, letterSpacing: "0.14em"}}>
      <button type="button" className="btn-ghost" onClick={onBack} style={{color: C.muted, letterSpacing: "0.14em"}}>
        ← SHAPE #{tokenId.toString()}
      </button>
    </div>
  );
}

function ManageIdentity({token, owned}: {token: SiteToken; owned: boolean}) {
  return (
    <div style={{display: "flex", flexWrap: "wrap", alignItems: "center", gap: 26}}>
      <Art src={token.image} alt={`Shape ${token.id.toString()}`} width={104} />
      <div>
        <div style={{fontSize: 28}}>Shape #{token.id.toString()}</div>
        <div style={{marginTop: 8, color: C.bodyDim, fontSize: 14}}>
          {token.di >= 0 ? `${DENOMINATIONS[token.di].label} ETH` : "Black Shape"}
        </div>
        <div style={{marginTop: 8, color: C.muted, fontSize: 11}}>
          {owned ? "Owned by you" : `Owned by ${short(token.owner)}`}
        </div>
      </div>
    </div>
  );
}

function ActionCard({
  protocol,
  title,
  description,
  consequence,
  unavailable,
  onClick,
}: {
  protocol: string;
  title: string;
  description: string;
  consequence: string;
  unavailable: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={unavailable !== null}
      className="manage-action-card"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 210,
        padding: 22,
        border: `1px solid ${unavailable ? C.rule : C.border}`,
        background: unavailable ? C.page : C.row,
        color: unavailable ? C.faint : C.ink,
        textAlign: "left",
        cursor: unavailable ? "default" : "pointer",
      }}
    >
      <div style={{...label, color: unavailable ? C.faint : C.muted}}>{protocol}</div>
      <div style={{marginTop: 16, fontSize: 20, lineHeight: 1.35}}>{title}</div>
      <p style={{margin: "12px 0 18px", color: unavailable ? C.faint : C.bodyDim, fontSize: 12, lineHeight: 1.7}}>
        {description}
      </p>
      <div style={{marginTop: "auto", paddingTop: 14, borderTop: `1px solid ${C.ruleInner}`, fontSize: 10, lineHeight: 1.6, letterSpacing: "0.08em"}}>
        {unavailable ?? consequence}
      </div>
    </button>
  );
}

function FlowHeading({title, body}: {title: string; body: string}) {
  return (
    <div style={{maxWidth: 760}}>
      <div style={{fontSize: 28, lineHeight: 1.3}}>{title}</div>
      <p style={{margin: "12px 0 28px", maxWidth: "64ch", color: C.bodyDim, fontSize: 13, lineHeight: 1.75}}>
        {body}
      </p>
    </div>
  );
}

function ResultCardView({card}: {card: ResultCard}) {
  return (
    <div style={{width: 160, flex: "0 0 160px"}}>
      <Art src={card.image} alt={card.id === null ? card.eyebrow : `Shape ${card.id.toString()}`} />
      <div style={{marginTop: 12, ...label}}>{card.eyebrow}</div>
      <div style={{marginTop: 6, color: C.ink, fontSize: 14}}>
        {card.id === null ? "ID pending" : `#${card.id.toString()}`}
      </div>
      <div style={{marginTop: 5, color: C.bodyDim, fontSize: 12}}>{card.value}</div>
      <div style={{marginTop: 7, color: C.muted, fontSize: 10, lineHeight: 1.5}}>{card.identity}</div>
    </div>
  );
}

function Outcome({before, after}: {before: React.ReactNode; after: React.ReactNode}) {
  return (
    <div className="manage-outcome">
      <div>
        <div style={{...label, marginBottom: 12}}>BEFORE</div>
        {before}
      </div>
      <div className="manage-outcome-arrow">→</div>
      <div>
        <div style={{...label, marginBottom: 12}}>AFTER</div>
        {after}
      </div>
    </div>
  );
}

function CurrentCard({
  token,
  eyebrow = "CURRENT SHAPE",
  identity = "Current live token",
}: {
  token: SiteToken;
  eyebrow?: string;
  identity?: string;
}) {
  return (
    <ResultCardView
      card={{
        id: token.id,
        image: token.image,
        value: `${DENOMINATIONS[token.di].label} ETH`,
        eyebrow,
        identity,
      }}
    />
  );
}

function SplitFlow({
  token,
  previews,
  previewUnavailable,
  ratio,
  childDenominationIndex,
  busy,
  onConfirm,
}: {
  token: SiteToken;
  previews: ResultCard[] | null;
  previewUnavailable: boolean;
  ratio: number;
  childDenominationIndex: number;
  busy: string | null;
  onConfirm: () => void;
}) {
  return (
    <>
      <FlowHeading
        title="Break into smaller Shapes"
        body={`Shape #${token.id.toString()} will be permanently burned and replaced by ${ratio} new ${DENOMINATIONS[childDenominationIndex].label} ETH Shapes. Their artwork is deterministic now; their IDs are assigned when the transaction executes.`}
      />
      <Outcome
        before={<CurrentCard token={token} eyebrow="BURNED SHAPE" identity="Will be burned permanently" />}
        after={
          previews ? (
            <div style={{display: "flex", flexWrap: "wrap", gap: 18}}>
              {previews.map((preview, index) => <ResultCardView key={index} card={preview} />)}
            </div>
          ) : (
            <PreviewStatus unavailable={previewUnavailable} />
          )
        }
      />
      <p style={{margin: "24px 0 0", maxWidth: "64ch", color: C.muted, fontSize: 12, lineHeight: 1.7}}>
        The total backing remains exactly {DENOMINATIONS[token.di].label} ETH. This does not undo
        a compose, and composing the new Shapes later will not restore #{token.id.toString()}.
      </p>
      <button type="button" className="btn-outline" onClick={onConfirm} disabled={!!busy || !previews} style={{marginTop: 26, padding: "11px 24px"}}>
        Split #{token.id.toString()} into {ratio} new Shapes
      </button>
    </>
  );
}

function DecomposeFlow({
  token,
  record,
  unavailable,
  busy,
  onSubmit,
}: {
  token: SiteToken;
  record: ComposeRecordPreview | null;
  unavailable: boolean;
  busy: string | null;
  onSubmit: () => void;
}) {
  const survivor = record
    ? buildComposeResultPreview(
        {
          denominationIndex: record.survivorDenominationIndex,
          inkGene: record.survivorInkGene,
          faceValueWei: DENOMINATIONS[record.survivorDenominationIndex].wei,
          modules: record.survivorModules,
        },
        token.id,
      )
    : null;
  const restored = record?.inputs.map((input) =>
    buildComposeResultPreview(
      {
        denominationIndex: input.denominationIndex,
        inkGene: input.inkGene,
        faceValueWei: DENOMINATIONS[input.denominationIndex].wei,
        modules: input.modules,
      },
      input.id,
    ),
  );

  return (
    <>
      <FlowHeading
        title="Undo the last grow"
        body={`Reverse only the newest compose. Shape #${token.id.toString()} keeps its ID and returns to its previous state; every Shape absorbed in that compose returns with its original ID and artwork.`}
      />
      <Outcome
        before={<CurrentCard token={token} />}
        after={
          survivor && restored ? (
            <div style={{display: "flex", flexWrap: "wrap", gap: 18}}>
              <ResultCardView
                card={{
                  id: token.id,
                  image: survivor.image,
                  value: `${DENOMINATIONS[survivor.denominationIndex].label} ETH`,
                  eyebrow: "UPDATED SURVIVOR",
                  identity: "Keeps current ID · returns to prior state",
                }}
              />
              {restored.map((preview) => (
                <ResultCardView
                  key={preview.tokenId.toString()}
                  card={{
                    id: preview.tokenId,
                    image: preview.image,
                    value: `${DENOMINATIONS[preview.denominationIndex].label} ETH`,
                    eyebrow: "RESTORED SHAPE",
                    identity: "Original ID and artwork return",
                  }}
                />
              ))}
            </div>
          ) : (
            <PreviewStatus unavailable={unavailable} />
          )
        }
      />
      <p style={{margin: "24px 0 0", maxWidth: "64ch", color: C.muted, fontSize: 12, lineHeight: 1.7}}>
        No ETH moves and no fee is charged. This Shape has {token.composeDepth} compose
        {token.composeDepth === 1 ? "" : "s"} remaining, and they can only be undone newest first.
      </p>
      <button type="button" className="btn-filled" onClick={onSubmit} disabled={!!busy || !record} style={{marginTop: 26, padding: "11px 24px"}}>
        {busy === "decompose" ? "Waiting for confirmation" : `Restore #${token.id.toString()} and ${record?.inputs.length ?? 0} absorbed Shape${record?.inputs.length === 1 ? "" : "s"}`}
      </button>
    </>
  );
}

function RedeemFlow({token, busy, onConfirm}: {token: SiteToken; busy: string | null; onConfirm: () => void}) {
  return (
    <>
      <FlowHeading
        title="Redeem its ETH"
        body={`Burn Shape #${token.id.toString()} and receive its exact ${DENOMINATIONS[token.di].label} ETH backing. This exits the Shape permanently.`}
      />
      <Outcome
        before={<CurrentCard token={token} eyebrow="BURNED SHAPE" identity="Will be burned permanently" />}
        after={
          <div style={{minWidth: 240, padding: "28px 30px", border: `1px solid ${C.border}`, background: C.row}}>
            <div style={label}>SENT TO OWNER</div>
            <div style={{marginTop: 14, fontSize: 28}}>{DENOMINATIONS[token.di].label} ETH</div>
            <div style={{marginTop: 10, color: C.muted, fontSize: 11}}>{token.backing.toString()} wei</div>
          </div>
        }
      />
      <button type="button" className="btn-filled" onClick={onConfirm} disabled={!!busy} style={{marginTop: 28, padding: "11px 24px"}}>
        Redeem #{token.id.toString()}
      </button>
    </>
  );
}

function SacrificeFlow({token, busy, onConfirm}: {token: SiteToken; busy: string | null; onConfirm: () => void}) {
  const blackImage = svgData(renderShape(token.seed, token.backing, token.id, token.inkGene, CANONICAL, true));
  return (
    <>
      <FlowHeading
        title="Make a Black Shape"
        body={`Keep token #${token.id.toString()}, but permanently send all ${DENOMINATIONS[token.di].label} ETH backing to an unspendable address. The Black Shape remains in the collection with no redeemable value.`}
      />
      <Outcome
        before={<CurrentCard token={token} />}
        after={
          <ResultCardView
            card={{
              id: token.id,
              image: blackImage,
              value: "0 ETH redeemable",
              eyebrow: "BLACK SHAPE",
              identity: "Keeps ID · backing is unrecoverable",
            }}
          />
        }
      />
      <button type="button" className="btn-outline" onClick={onConfirm} disabled={!!busy} style={{marginTop: 28, padding: "11px 24px"}}>
        Sacrifice #{token.id.toString()}
      </button>
    </>
  );
}

function PreviewStatus({unavailable}: {unavailable: boolean}) {
  return (
    <div style={{padding: "28px 30px", border: `1px solid ${C.rule}`, color: C.muted, fontSize: 12, lineHeight: 1.7}}>
      {unavailable ? "Exact preview is temporarily unavailable." : "Calculating exact result…"}
    </div>
  );
}

function ConfirmButtons({
  busy,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  busy: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{display: "flex", flexWrap: "wrap", gap: 12}}>
      <button type="button" className="btn-filled" onClick={onConfirm} disabled={busy} style={{padding: "11px 20px"}}>
        {busy ? "Waiting for confirmation" : confirmLabel}
      </button>
      <button type="button" className="btn-outline" onClick={onCancel} disabled={busy} style={{padding: "11px 20px"}}>
        Cancel
      </button>
    </div>
  );
}
