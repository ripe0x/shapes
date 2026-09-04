#!/usr/bin/env bash
# Fail if a document names a function its receiver contract does not have.
#
# Integration docs are read as executable claims: someone copies a call out of BUILDING.md and
# expects it to compile. A selector that has been renamed, removed, or moved to another contract
# does not announce itself, so this compares every `shapes.foo(` call, every `| `foo(` table entry,
# and every backticked identifier in prose (`foo()` and `Shapes.foo`) against the real ABI of
# Shapes, which is where every protocol action and view lives.
#
#   ./script/check-docs.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

forge build --skip test >/dev/null 2>&1

DOCS=(README.md BUILDING.md SPEC.md SECURITY.md METADATA.md docs/SHAPES_V2_SPEC.md docs/DECOMPOSE_SPEC.md
      project/ARCHITECTURE.md indexer/README.md)

SHAPES_ABI="$(mktemp)"
trap 'rm -f "$SHAPES_ABI"' EXIT
forge inspect Shapes abi --json > "$SHAPES_ABI" 2>/dev/null

python3 -c '
import json, re, sys, pathlib

def names_of(path):
    return {e["name"] for e in json.load(open(path)) if e["type"] in ("function", "event")}

# Receiver variable name -> ABI of the contract it refers to across these docs.
RECEIVERS = {"shapes": names_of(sys.argv[1])}
# Solidity builtins and language constructs read like calls but are not contract members.
BUILTINS = {"keccak256", "abi", "require", "revert", "assert", "address", "uint256", "bytes32",
            "type", "new", "emit", "if", "for", "while", "return",
            "receive", "fallback", "constructor"}
# Errors and structs are declared on the interface, not the ABI function/event list, and inherited
# ERC-721/ERC-165 members are real but come from OpenZeppelin rather than IShapes. Both are named in
# prose the same way a function is, so they are read out of the sources instead of the ABI.
def declared_in(paths, pattern):
    out = set()
    for path in paths:
        out |= set(re.findall(pattern, pathlib.Path(path).read_text()))
    return out

INTERFACES = ["src/interfaces/IShapes.sol", "src/interfaces/IAdminControl.sol"]
NON_ABI = declared_in(INTERFACES, r"\berror\s+(\w+)") | declared_in(INTERFACES, r"\bstruct\s+(\w+)")
docs = sys.argv[2:]
bad = []
for d in docs:
    p = pathlib.Path(d)
    if not p.exists():
        continue
    text = p.read_text()
    for receiver, names in RECEIVERS.items():
        for c in sorted(set(re.findall(rf"{receiver}\.(\w+)\(", text))):
            if c not in names and c not in BUILTINS:
                bad.append(f"{d}: {receiver}.{c}() is not on {receiver}")
    for c in sorted(set(re.findall(r"\| `(\w+)\(", text))):
        if c not in RECEIVERS["shapes"] and c not in BUILTINS:
            bad.append(f"{d}: {c}() is not on Shapes")
    # Prose names members two ways: `foo()` and `Shapes.foo`. Both are claims about the ABI.
    prose = set(re.findall(r"`(\w+)\(\)`", text)) | set(re.findall(r"`Shapes\.(?!sol\b)(\w+)`", text))
    for c in sorted(prose):
        if c not in RECEIVERS["shapes"] and c not in BUILTINS and c not in NON_ABI:
            bad.append(f"{d}: `{c}` is named in prose but is not on Shapes")

if bad:
    print("\n".join(bad))
    sys.exit(1)
print(f"ok: every selector named across {len(docs)} documents exists on its stated contract")
' "$SHAPES_ABI" "${DOCS[@]}"
