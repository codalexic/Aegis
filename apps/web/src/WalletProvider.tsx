import { useMemo, useRef, useState, type ReactNode } from "react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { WalletProviderBase } from "./wallet-react";

// Phantom-only provider uses wallet-adapter-react's base provider. The mobile
// auto-discovery provider brings local signing code that this app never needs.
export function WalletProvider({ children }: { children: ReactNode }) {
  const adapter = useMemo(() => new PhantomWalletAdapter(), []);
  const wallets = useMemo(() => [adapter], [adapter]);
  const isUnloadingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  return <WalletProviderBase wallets={wallets} adapter={adapter} isUnloadingRef={isUnloadingRef}
    onSelectWallet={() => {}} onConnectError={() => setError("Could not connect Phantom. Check the extension and try again.")}
    onError={() => setError("Wallet request failed or was declined. Check Phantom and try again.")}>
    {children}
    {error && <p className="notice error wallet-error" role="alert">{error} <button onClick={() => setError(null)}>Dismiss</button></p>}
  </WalletProviderBase>;
}
