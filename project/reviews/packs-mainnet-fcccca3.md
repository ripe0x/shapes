# Mainnet Packs site candidate review

- Candidate: `fcccca3ab7eaea13c34be3b6e3df551905b73f94` against parent `4310bca`.
- Reviewer: independent `mainnet_packs_review` agent, read-only, 2026-10-10. Implementer: root agent.
- Owner goal: serve the newly deployed mainnet Packs contract on the production site while retaining Sepolia on the separate test site and local preview.
- Scope: Packs chain/address selection, wallet writes, exact quote payment, owned Shape approval, renderer pointer checks, production build guard, and focused tests.
- Finding: no concrete blocking code defect. Mainnet and Sepolia addresses match the owner-supplied records; the page selects by the loaded Shapes chain, verifies contract pointers, and sends writes on that same chain. Quote and minimum are read onchain. The production hostname guard rejects the Sepolia record.
- Evidence limit: mainnet has zero minted packs, so successful live merge/open/redeem and owned-Shape approval through the mainnet UI cannot yet be exercised. Read-only `eth_call` confirmed exact-quote creation, approval, and empty-source merge rejection. This is a coverage limit, not a confirmed defect.
- Review was independent of implementation. It did not inspect Netlify secret values or authorize a transaction or release; those are separate configuration and operator checks.
