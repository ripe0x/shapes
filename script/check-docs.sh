#!/usr/bin/env bash
# Fail if a document names a Shapes function the compiled contract does not have.
#
# Integration docs are read as executable claims: someone copies a call out of BUILDING.md and
# expects it to compile. A selector that has been renamed or removed does not announce itself, so
# this compares every `shapes.foo(` and every `| `foo(` table entry against the real ABI.
#
#   ./script/check-docs.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

forge build --skip test >/dev/null 2>&1

DOCS=(README.md BUILDING.md SPEC.md SECURITY.md METADATA.md SHAPES_V2_SPEC.md DECOMPOSE_SPEC.md indexer/README.md)

forge inspect Shapes abi --json 2>/dev/null | python3 -c '
import json, re, sys, pathlib

names = {e["name"] for e in json.load(sys.stdin) if e["type"] in ("function", "event")}
# Solidity builtins and language constructs read like calls but are not contract members.
BUILTINS = {"keccak256", "abi", "require", "revert", "assert", "address", "uint256", "bytes32",
            "type", "new", "emit", "if", "for", "while", "return"}
docs = sys.argv[1:]
bad = []
for d in docs:
    p = pathlib.Path(d)
    if not p.exists():
        continue
    text = p.read_text()
    called = set(re.findall(r"shapes\.(\w+)\(", text)) | set(re.findall(r"\| `(\w+)\(", text))
    for c in sorted(called):
        if c not in names and c not in BUILTINS:
            bad.append(f"{d}: {c}() is not on the contract")

if bad:
    print("\n".join(bad))
    sys.exit(1)
print(f"ok: every selector named across {len(docs)} documents exists on Shapes")
' "${DOCS[@]}"
