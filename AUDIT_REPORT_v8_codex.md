# Shapes architecture release audit (Codex, independent)

Target: `7f6ccb5`, branch `claude/contracts-page`, pre-mainnet snapshot. Delivered by the user
from a Codex session on 2026-09-03; recorded here verbatim in substance.

## Bottom line

No reportable Critical, High, Medium, or Low security finding was identified in the fixed
snapshot. The nine required adversarial proofs of concept all pass without producing an exploit.

## Findings table

| ID | Severity | Title | path:line | One-line impact |
| --- | --- | --- | --- | --- |
| none | none | No reportable security findings | none | No tested path steals ETH, redeems unbacked value, corrupts ownership, or bypasses the authority model. |

## Verification and reproduction

Nine retained attempts under `test/audit/`: `test_Audit01_DecomposeAndSplitReceiverReentrancy`,
`test_Audit02_PositionsFailuresMalformedGasAndStaticReentry`,
`test_Audit03_ForcedEtherDoesNotChangeViewsOrFeeWithdrawal`,
`test_Audit04_LegitimateRecordsRejectDuplicatesAndPreserveProvenance`,
`test_Audit05_FeeAccountingAndRevertingRecipient`, `test_Audit06_MintStartBoundaryAndAuctionEthPath`,
`test_Audit07_DirectLibraryCallsCannotTouchTokenStorage`,
`test_Audit08_PresentationLockCannotBeReorderedOrBypassed`,
`test_Audit09_AuctionOwnerLotCardsAndEthSettlementArePullBased`.

Baseline reproduced: `forge build --sizes`; 541 Foundry tests in each profile (532 plus the nine
audit tests); 4/4 fork tests on publicnode; Medusa 11/11; Anvil deploy plus end-to-end script.

## Properties verified

Reserve solvency, redemption ordering, reentrant redemption blocked, exact `burnBacking`
transition, fee withdrawal, backing conserved across recomposition; compose record reversibility,
decompose LIFO and id reuse, split sum and provenance, owner-token coherence across callbacks,
preview and mutation sharing validation gates, narrowing casts (ladder-bounded for origins and
child indexes; id and split-record widths rest on economic bounds); `mintStart` gating incl. the
escrow's ETH bids and the genesis exception; seeds distinct, grindable and non-economic; mint fee
cap; admin as the only privileged role; presentation lock ordering with the live copy lock;
pointer validation, permanence and bounded position reads; artist attestation binding and
permissionless relay; mint, redemption and recomposition callbacks; self-custody guard on every
ERC-721 path; auction house without authority, card and ETH bids preserving accounting,
pull-based settlement; pure renderer and JSON-safe copy.

## Trust model

Every `Shapes` entrypoint that reaches a library body runs its gate first (`onlyAdmin` for
configuration writes; `nonReentrant` plus ownership and liveness gates for compose, split and
decompose; read-only decoders for records, state and previews; `attestArtist` ungated by design
with the signature as the gate). Direct library calls were attempted for every public library
function; mutating calls are rejected by compiler call protection, view and pure dispatch stays
read-only. The link is fixed bytecode with no setter, proxy or CREATE2 redirection.

## Not exploitable, worth knowing

Forced ETH is inert surplus; a reverting fee recipient blocks only its own withdrawal; a hostile
positions target can lie or burn its stipend but cannot reenter; seeds are grindable; the auction
house is ordinary escrow; the owner token is not an admin key; id and split-record widths carry
documented economic bounds.

## Appendix

Compiler lint diagnostics (a Solar preprocessor note on the `IERC165` override) do not affect the
build; the audit mocks use `selfdestruct` as a test primitive.
