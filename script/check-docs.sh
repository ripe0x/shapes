#!/usr/bin/env bash
# Fail if a document, or the site's hand-written ABI, names something the compiled contracts do
# not have.
#
# Integration docs are read as executable claims: someone copies a call out of BUILDING.md and
# expects it to compile. A selector that has been renamed or removed does not announce itself, so
# this compares every `shapes.foo(` and every `| `foo(` table entry against the real ABI.
#
# The site is the same class of claim with a worse failure: `preview/src/chain/abi.ts` is typed
# out by hand, so drift compiles, ships, and breaks inside viem's decoder at runtime.
#
#   ./script/check-docs.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

forge build --skip test >/dev/null 2>&1

DOCS=(README.md BUILDING.md SPEC.md SECURITY.md METADATA.md SHAPES_V2_SPEC.md DECOMPOSE_SPEC.md \
      PROJECT_OVERVIEW.md indexer/README.md)

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

# The site's vendored ABI, compared against the same compiled contracts. Run from preview/, which
# is where viem resolves; skipped with a warning if its dependencies are not installed.
if (cd preview && node --input-type=module -e "await import('viem')") >/dev/null 2>&1; then
  (cd preview && node scripts/check-vendored-abi.mjs)
else
  echo "warn: viem does not resolve from preview/; skipping the vendored ABI check" >&2
fi
