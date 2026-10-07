# Moving Shape Packs to its own repository

This directory is a snapshot of the `shape-packs` repository, and `../shape-packs.bundle` is the
same repository with its full commit history. The session that built it could not create
`ripe0x/shape-packs`, so both were committed here. Neither belongs in the Shapes repository
long-term.

1. Create the empty repository `ripe0x/shape-packs` on GitHub (no README, no license).
2. Restore the history from the bundle and push it:

   ```sh
   git clone shape-packs.bundle shape-packs
   cd shape-packs
   git submodule update --init
   git remote set-url origin https://github.com/ripe0x/shape-packs
   git push -u origin main
   ```

3. Delete this directory and the bundle from the Shapes repository.

The submodule `lib/shapes` points at `https://github.com/ripe0x/shapes` at the deployed mainnet
commit `1b84c10`, which is why this snapshot has no `lib/` contents.
