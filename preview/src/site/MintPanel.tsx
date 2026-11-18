import {useAccount, useBalance} from "wagmi";
import {MintPanelContent, type MintPanelProps} from "./MintPanelContent";

export type {MintPanelProps} from "./MintPanelContent";

export function MintPanel(props: MintPanelProps) {
  const {address} = useAccount();
  const {data: balance} = useBalance({address, chainId: props.chainId});
  return <MintPanelContent {...props} balance={balance} />;
}
