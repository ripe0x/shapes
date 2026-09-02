import type React from "react";
import type { Deployment } from "../chain/abi";
import { addrUrl } from "./ui";

/**
 * Footer shared by the app shell and the launch page: attribution, an optional link to the
 * connected contract, and a jump back to the top of the page. `dep` is omitted on the launch page,
 * which has no connected contract. `topRule` adds the 1px rule the app shell needs to close off
 * its last section; the launch page supplies its own rule above the footer. `reserve` is the
 * contract reserve line (e.g. "The contract holds X ETH backing N Shapes."), rendered under the
 * attribution when given; omitted wherever the caller has no loaded chain data.
 */
export function SiteFooter({
  dep,
  topRule = false,
  reserve,
}: {
  dep?: Deployment | null;
  topRule?: boolean;
  reserve?: React.ReactNode;
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
          {dep && (
            <a href={addrUrl(dep.shapes, dep.chainId)} target="_blank" rel="noreferrer">
              Contract
            </a>
          )}
          <a href="#top">Back to top</a>
        </span>
      </div>
    </footer>
  );
}
