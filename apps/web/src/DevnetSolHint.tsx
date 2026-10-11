import { useEffect, useState } from "react";
import { Notice } from "./Notice";

export function DevnetSolHint({ readBalance }: { readBalance: () => Promise<bigint | null> }) {
  const [empty, setEmpty] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let active = true;
    void readBalance().then((balance) => { if (active) setEmpty(balance === 0n); }).catch(() => {});
    return () => { active = false; };
  }, [readBalance]);
  return empty && !dismissed ? <Notice tone="info" message="This wallet needs a little devnet SOL for fees."
    faucet onDismiss={() => setDismissed(true)} /> : null;
}
