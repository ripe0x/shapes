import React from "react";
import {type PublicClient} from "viem";
import {DENOMINATIONS, shapeLensAbi, type Deployment} from "../chain/abi";
import {C, label} from "./theme";
import {Art, OwnerTokenBanner, Section, TxStage, txStageLabel, type PendingTx} from "./ui";
import type {SiteData, SiteToken} from "./data";
import {buildComposeResultPreview, type ComposeResultPreview} from "./composePreview";
import {
  composeBurnIds,
  composeRung,
  eligibleRungTokens,
  isCompleteRungSelection,
  ownedTokens,
  selectedComposeTokens,
} from "./composeSelection";
import {ownerTokenNotices} from "./ownerTokenNotice";

export interface ComposeDraft {
  session: number;
  selectedIds: bigint[];
  survivorId: bigint | null;
  phase: "select" | "review";
  backView: "collection" | "manage";
}

export function ComposeWorkspace({
  draft,
  data,
  dep,
  publicClient,
  address,
  busy,
  pendingTx,
  txErr,
  onChange,
  onCancel,
  onOpenToken,
  onSubmit,
}: {
  draft: ComposeDraft;
  data: SiteData | null;
  dep: Deployment;
  publicClient: PublicClient | undefined;
  address: `0x${string}` | undefined;
  busy: string | null;
  pendingTx: PendingTx | null;
  txErr: {op: string; text: string} | null;
  onChange: (next: ComposeDraft) => void;
  onCancel: () => void;
  onOpenToken: (id: bigint) => void;
  onSubmit: (survivor: SiteToken, burnIds: bigint[]) => void;
}) {
  const inventory = React.useMemo(
    () => (address ? ownedTokens(data?.tokens ?? [], address) : []),
    [address, data],
  );
  const selected = React.useMemo(
    () => selectedComposeTokens(inventory, draft.selectedIds),
    [draft.selectedIds, inventory],
  );
  const sourceIndex = selected[0]?.di ?? null;
  const rung = sourceIndex === null ? null : composeRung(sourceIndex);
  const complete = !!address && isCompleteRungSelection(inventory, address, draft.selectedIds);
  const lockedSurvivor = draft.backView === "manage" ? draft.survivorId : null;
  const requiredTotal = rung?.totalShapes ?? 0;

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const change = (patch: Partial<ComposeDraft>) => onChange({...draft, ...patch});

  const toggle = (token: SiteToken) => {
    if (busy || token.di < 0 || composeRung(token.di) === null) return;
    const key = token.id.toString();
    const has = draft.selectedIds.some((id) => id.toString() === key);
    if (has) {
      if (lockedSurvivor === token.id) return;
      const selectedIds = draft.selectedIds.filter((id) => id !== token.id);
      change({
        selectedIds,
        survivorId: draft.survivorId === token.id ? null : draft.survivorId,
        phase: "select",
      });
      return;
    }

    if (sourceIndex !== null && token.di !== sourceIndex) return;
    const tokenRung = composeRung(token.di);
    if (!tokenRung) return;
    const available = eligibleRungTokens(inventory, address!, token.di).length;
    if (available < tokenRung.totalShapes || draft.selectedIds.length >= tokenRung.totalShapes) return;
    change({selectedIds: [...draft.selectedIds, token.id], phase: "select"});
  };

  const clear = () => {
    const selectedIds = lockedSurvivor === null ? [] : [lockedSurvivor];
    change({selectedIds, survivorId: lockedSurvivor, phase: "select"});
  };

  if (!address) {
    return (
      <main>
        <ComposeModeHeader onBrowse={onCancel} />
        <Section title="COMPOSE SHAPES" last>
          <div style={{fontSize: 15}}>Reconnect the owning wallet to continue this composition.</div>
        </Section>
      </main>
    );
  }

  if (draft.phase === "review") {
    return (
      <ComposeReview
        draft={draft}
        selected={selected}
        complete={complete}
        dep={dep}
        publicClient={publicClient}
        busy={busy}
        pendingTx={pendingTx}
        error={txErr?.op === "compose" ? txErr.text : null}
        lockedSurvivorId={lockedSurvivor}
        ownerTokenId={data?.ownerToken ?? null}
        onChange={change}
        onEdit={() => change({phase: "select"})}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    );
  }

  return (
    <main style={{paddingBottom: draft.selectedIds.length > 0 ? 140 : 0}}>
      <ComposeModeHeader onBrowse={onCancel} />
      <Section title="COMPOSE SHAPES" pad="30px 48px 34px 32px">
        <div style={{fontSize: 24, lineHeight: 1.3}}>
          {rung
            ? `Select ${rung.totalShapes} matching Shapes`
            : "Choose Shapes to compose"}
        </div>
        <p style={{margin: "10px 0 0", maxWidth: "66ch", color: C.muted, fontSize: 12, lineHeight: 1.7}}>
          {rung
            ? `${draft.selectedIds.length} of ${rung.totalShapes} selected. Together they become one ${DENOMINATIONS[rung.targetIndex].label} ETH Shape.`
            : "Choose the first Shape to set the denomination. This flow composes one measured ladder step at a time."}
        </p>
      </Section>

      <div className="shape-token-grid">
        {inventory.map((token) => {
          const selectedNow = draft.selectedIds.some((id) => id === token.id);
          const tokenRung = composeRung(token.di);
          const matchingCount = tokenRung
            ? eligibleRungTokens(inventory, address, token.di).length
            : 0;
          const wrongDenomination = sourceIndex !== null && token.di !== sourceIndex;
          const full = !!rung && draft.selectedIds.length >= requiredTotal && !selectedNow;
          const disabled =
            token.di < 0 ||
            tokenRung === null ||
            matchingCount < (tokenRung?.totalShapes ?? Infinity) ||
            wrongDenomination ||
            full ||
            lockedSurvivor === token.id;
          const reason = token.di < 0
            ? "Black Shapes cannot be composed."
            : tokenRung === null
              ? "This Shape is already at the highest denomination."
              : matchingCount < tokenRung.totalShapes
                ? `Requires ${tokenRung.totalShapes} matching Shapes.`
                : wrongDenomination
                  ? "Choose this denomination separately."
                  : lockedSurvivor === token.id
                    ? "Keeps its ID."
                    : full
                      ? "Required set is complete."
                      : null;
          return (
            <ComposeSelectionCard
              key={token.id.toString()}
              token={token}
              selected={selectedNow}
              disabled={disabled}
              reason={reason}
              survivor={lockedSurvivor === token.id}
              onToggle={() => toggle(token)}
              onOpen={() => onOpenToken(token.id)}
            />
          );
        })}
      </div>

      {inventory.length === 0 && data && (
        <div style={{padding: 48, color: C.muted, fontSize: 13}}>This wallet has no Shapes to compose.</div>
      )}

      {draft.selectedIds.length > 0 && rung && (
        <div className="compose-selection-tray" role="status" aria-live="polite">
          <div style={{minWidth: 0}}>
            <div style={{fontSize: 13}}>
              {draft.selectedIds.length} of {requiredTotal} selected
            </div>
            <div style={{marginTop: 4, color: C.muted, fontSize: 11}}>
              {DENOMINATIONS[sourceIndex!].label} ETH each · {DENOMINATIONS[rung.targetIndex].label} ETH result
            </div>
          </div>
          <div className="compose-tray-actions">
            <button type="button" className="btn-ghost" onClick={clear} style={{color: C.muted, fontSize: 11, letterSpacing: "0.1em"}}>
              CLEAR
            </button>
            <button type="button" className="btn-ghost" onClick={onCancel} style={{color: C.muted, fontSize: 11, letterSpacing: "0.1em"}}>
              CANCEL
            </button>
            <button
              type="button"
              className="btn-filled"
              disabled={!complete}
              onClick={() => change({phase: "review"})}
              style={{padding: "10px 18px", letterSpacing: "0.06em"}}
            >
              REVIEW COMPOSITION
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function ComposeModeHeader({onBrowse}: {onBrowse: () => void}) {
  return (
    <Section title="MY SHAPES" pad="26px 48px 26px 32px">
      <div style={{display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 20}}>
        <div style={{fontSize: 15}}>Select matching Shapes to compose.</div>
        <div className="shape-mode-toggle" role="group" aria-label="My Shapes mode">
          <button type="button" aria-pressed={false} onClick={onBrowse}>BROWSE</button>
          <button type="button" aria-pressed={true}>COMPOSE</button>
        </div>
      </div>
    </Section>
  );
}

function ComposeSelectionCard({
  token,
  selected,
  disabled,
  reason,
  survivor,
  onToggle,
  onOpen,
}: {
  token: SiteToken;
  selected: boolean;
  disabled: boolean;
  reason: string | null;
  survivor: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <div style={{minWidth: 0}}>
      <button
        type="button"
        aria-pressed={selected}
        disabled={disabled}
        className={`compose-select-card${selected ? " selected" : ""}`}
        onClick={onToggle}
      >
        <div style={{position: "relative"}}>
          <Art src={token.image} alt={`Shape ${token.id}`} />
          {(selected || survivor) && (
            <span className="compose-selection-badge">{survivor ? "KEEPS ID" : "SELECTED"}</span>
          )}
        </div>
        <div style={{marginTop: 11, display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11}}>
          <span>#{token.id.toString()}</span>
          <span>{token.di >= 0 ? `${DENOMINATIONS[token.di].label} ETH` : "Black"}</span>
        </div>
        {reason && <div style={{marginTop: 7, color: C.muted, fontSize: 10, lineHeight: 1.45}}>{reason}</div>}
      </button>
      <button type="button" className="btn-ghost compose-details-link" onClick={onOpen}>
        VIEW DETAILS
      </button>
    </div>
  );
}

function ComposeReview({
  draft,
  selected,
  complete,
  dep,
  publicClient,
  busy,
  pendingTx,
  error,
  lockedSurvivorId,
  ownerTokenId,
  onChange,
  onEdit,
  onCancel,
  onSubmit,
}: {
  draft: ComposeDraft;
  selected: SiteToken[];
  complete: boolean;
  dep: Deployment;
  publicClient: PublicClient | undefined;
  busy: string | null;
  pendingTx: PendingTx | null;
  error: string | null;
  lockedSurvivorId: bigint | null;
  ownerTokenId: bigint | null;
  onChange: (patch: Partial<ComposeDraft>) => void;
  onEdit: () => void;
  onCancel: () => void;
  onSubmit: (survivor: SiteToken, burnIds: bigint[]) => void;
}) {
  const [preview, setPreview] = React.useState<ComposeResultPreview | null>(null);
  const [previewFailed, setPreviewFailed] = React.useState(false);
  const survivor = selected.find((token) => token.id === draft.survivorId) ?? null;
  const burnIds = React.useMemo(
    () => (draft.survivorId === null ? [] : composeBurnIds(draft.selectedIds, draft.survivorId)),
    [draft.selectedIds, draft.survivorId],
  );
  const burnKey = burnIds.map(String).join(",");

  React.useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewFailed(false);
    if (!complete || !survivor || !publicClient) return;
    void publicClient
      .readContract({
        address: dep.lens,
        abi: shapeLensAbi,
        functionName: "previewCompose",
        args: [survivor.id, burnIds],
      })
      .then((result) => {
        if (!cancelled) setPreview(buildComposeResultPreview(result, survivor.id));
      })
      .catch(() => {
        if (!cancelled) setPreviewFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // burnKey is the stable representation of the sorted burn-id list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [burnKey, complete, dep.lens, publicClient, survivor]);

  if (!complete) {
    return (
      <main>
        <ComposeModeHeader onBrowse={onCancel} />
        <Section title="COMPOSE" last>
          <div style={{fontSize: 15}}>The selected Shapes changed or are no longer available.</div>
          <button type="button" className="btn-outline" onClick={onEdit} style={{marginTop: 20, padding: "9px 16px"}}>
            EDIT SELECTION
          </button>
        </Section>
      </main>
    );
  }

  const rung = composeRung(selected[0].di)!;
  return (
    <main>
      <ComposeModeHeader onBrowse={onCancel} />
      <Section title="REVIEW COMPOSITION" pad="30px 48px 46px 32px" last>
        <button type="button" className="btn-ghost" onClick={onEdit} disabled={!!busy} style={{marginBottom: 28, color: C.muted, fontSize: 11, letterSpacing: "0.12em"}}>
          ← EDIT SELECTION
        </button>
        <div style={{fontSize: 24, lineHeight: 1.3}}>
          {lockedSurvivorId === null
            ? "Choose the Shape that keeps its identity"
            : `Shape #${lockedSurvivorId.toString()} keeps its identity`}
        </div>
        <p style={{margin: "10px 0 26px", maxWidth: "66ch", color: C.muted, fontSize: 12, lineHeight: 1.7}}>
          {lockedSurvivorId === null
            ? "The survivor keeps its token ID, history, and undo stack. Your choice also determines the exact resulting artwork."
            : "You started from this Shape's Manage page, so it remains the survivor. It keeps its token ID, history, and undo stack."}
        </p>

        <div className="compose-survivor-grid" role="radiogroup" aria-label="Shape that keeps its identity">
          {selected.map((token) => {
            const chosen = token.id === draft.survivorId;
            return (
              <button
                key={token.id.toString()}
                type="button"
                role="radio"
                aria-checked={chosen}
                className={`compose-survivor-card${chosen ? " selected" : ""}`}
                onClick={() => onChange({survivorId: token.id})}
                disabled={!!busy || lockedSurvivorId !== null}
              >
                <Art src={token.image} alt={`Shape ${token.id}`} />
                <div style={{marginTop: 9, fontSize: 11}}>#{token.id.toString()}</div>
                <div style={{marginTop: 5, color: chosen ? C.ink : C.muted, fontSize: 10}}>
                  {chosen ? "KEEPS ID" : "CHOOSE"}
                </div>
              </button>
            );
          })}
        </div>

        {survivor && (
          <div style={{marginTop: 36}}>
            <div style={{...label, marginBottom: 14}}>EXACT RESULT</div>
            <div className="compose-review-outcome">
              <div>
                <div style={{fontSize: 13}}>{selected.length} selected Shapes</div>
                <div style={{marginTop: 8, color: C.muted, fontSize: 11, lineHeight: 1.6}}>
                  #{survivor.id.toString()} keeps its ID · {burnIds.length} Shape{burnIds.length === 1 ? "" : "s"} absorbed
                </div>
              </div>
              <div className="compose-review-arrow">→</div>
              {preview ? (
                <div style={{maxWidth: 230}}>
                  <Art src={preview.image} alt={`Composed Shape ${survivor.id}`} />
                  <div style={{marginTop: 10, fontSize: 13}}>Shape #{survivor.id.toString()}</div>
                  <div style={{marginTop: 5, color: C.muted, fontSize: 11}}>
                    {DENOMINATIONS[rung.targetIndex].label} ETH
                  </div>
                </div>
              ) : (
                <div style={{color: C.muted, fontSize: 12}}>
                  {previewFailed ? "Exact preview is temporarily unavailable." : "Calculating exact result…"}
                </div>
              )}
            </div>

            <div style={{marginTop: 26, maxWidth: "70ch", color: C.bodyDim, fontSize: 12, lineHeight: 1.75}}>
              No ETH moves and no fee is charged. The other token IDs are absorbed into #{survivor.id.toString()}.
              Undoing its newest composition restores them with their original IDs and artwork.
            </div>
            <OwnerTokenBanner
              notices={ownerTokenNotices({
                action: "compose",
                actingTokenId: survivor.id,
                donorIds: burnIds,
                ownerTokenId,
              })}
            />
            <button
              type="button"
              className="btn-filled"
              disabled={!!busy || !preview}
              onClick={() => onSubmit(survivor, burnIds)}
              style={{marginTop: 28, padding: "11px 22px"}}
            >
              {txStageLabel(
                "compose",
                `COMPOSE ${selected.length} SHAPES INTO SHAPE #${survivor.id.toString()}`,
                busy,
                pendingTx,
              ).toUpperCase()}
            </button>
            <TxStage op="compose" busy={busy} pendingTx={pendingTx} chainId={dep.chainId} />
          </div>
        )}

        {error && <p style={{margin: "20px 0 0", maxWidth: "60ch", color: C.muted, fontSize: 12, lineHeight: 1.7}}>{error}</p>}
      </Section>
    </main>
  );
}
