import type React from "react";

/**
 * Footer shared by the app shell and the launch page: attribution, a link to the docs, a link to
 * the contracts page, and a jump back to the top of the page. `topRule` adds the 1px rule the app
 * shell needs to close off its last section; the launch page supplies its own rule above the
 * footer. `reserve` is the contract reserve line (e.g. "The contract holds X ETH backing N
 * Shapes."), rendered under the attribution when given; omitted wherever the caller has no loaded
 * chain data. `onContracts` navigates within a mounted SiteApp's own view state; omitted where no
 * SiteApp is mounted (the standalone marketing landing page). The docs link is always a plain
 * `/docs` href: it is a real route on every host, not a SiteApp view.
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
          <a href="/contracts" onClick={onContracts ? (event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            onContracts();
          } : undefined}>Contracts</a>
          <a href="#top">Back to top</a>
        </span>
      </div>
    </footer>
  );
}
