import type React from "react";

/**
 * Footer shared by the app shell and the launch page: attribution, a link to the docs, a link to
 * the contracts page, and a jump back to the top of the page. `topRule` adds the 1px rule the app
 * shell needs to close off its last section; the launch page supplies its own rule above the
 * footer. `reserve` is the contract reserve line (e.g. "The contract holds X ETH backing N
 * Shapes."), rendered under the attribution when given; omitted wherever the caller has no loaded
 * chain data. `onContracts` navigates within a mounted SiteApp's own view state; omitted where no
 * SiteApp is mounted (the standalone marketing landing page), where the link falls back to a plain
 * `/contracts` href. The docs link is always a plain `/docs` href: it is a real route on every
 * host, not a SiteApp view.
 */
export function SiteFooter({
  topRule = false,
  reserve,
  onContracts,
}: {
  topRule?: boolean;
  reserve?: React.ReactNode;
  onContracts?: () => void;
}) {
  return (
    <footer className={topRule ? "site-footer-outer site-footer-ruled" : "site-footer-outer"}>
      <div className="site-footer">
        <span>
          An Ethereum primitive by{" "}
          <a href="https://x.com/ripe0x" target="_blank" rel="noreferrer">
            ripe
          </a>
          {reserve && (
            <>
              <br />
              {reserve}
            </>
          )}
        </span>
        <span className="site-footer-links">
          <a href="/docs">Docs</a>
          {onContracts ? (
            <button type="button" className="btn-ghost" onClick={onContracts}>Contracts</button>
          ) : (
            <a href="/contracts">Contracts</a>
          )}
          <a href="#top">Back to top</a>
        </span>
      </div>
    </footer>
  );
}
