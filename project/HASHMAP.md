# Hash map: pre-publication history rewrite

On 2026-08-25 the full history (223 commits, all refs) was rewritten with git-filter-repo to scrub a personal identity before the repo went public: author/committer mailmap to ripe0x, co-author trailers rewritten, identity strings removed from messages and blobs. Every commit hash changed; the root commit was affected, so there is no shared prefix with the old history.

Commit hashes cited in project/ docs, the x-ray report, and older commit messages refer to the OLD history. Translate with this table (old -> new, abbreviated):

    074fc30 a8849e7   (preserve/renderer-wip tip)
    127a589 975b39c
    13f060a 496b4bd
    1672d08 bf523a2
    180037c 48e7510   (title research prompt landing)
    2167dc7 fbc0b8d   (audit fix wave)
    383be38 b8b9cdb   (audit fix wave)
    3f46dbc a9292cd
    4086aa7 172995f   (old main tip at rewrite time)
    4e6b3d8 325a6a5   (audit base commit)
    6480f1c 09fa11e   (audit artifacts landing)
    6b4b87f 0e8e40b
    8c30e51 ce20125   (doc truth pass)
    8eb0235 9a9d0cf   (canonical docs created)
    95cdc28 49ba70c   (preserve/split-gas-measure tip)
    a0ff0af b305fa4   (audit fix wave: both Highs)
    ce4c7e4 54c1834   (surface port preservation; branch since deleted)
    d2f2e59 ee25e0e   (audit fix wave)
    da1fa53 8e31983   (audit fix wave: L-1)
    dabf2ad 83707aa   (audit fix wave: L-3)
    e20a1b3 8ef1cbd   (audit fix wave: M-2/L-2/L-4/I-6)
    ee79eb5 99afeb8   (depersonalization edits)
    f048647 b06e6c7
    f73548b 2c8be70
    f7fd92b 1db7777   (chain-1 ladder deploy guard)

The complete map for all 223 commits is not stored in the repo (it enumerates the scrubbed history); it lives with the rewrite artifacts outside the repo. Any other old hash can be located by commit subject, which the rewrite preserved.
