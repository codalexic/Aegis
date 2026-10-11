import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { WalletProviderBase } from "./wallet-react";

type PhantomEvents = {
  on(event: "accountChanged", listener: (key: unknown) => void): void;
  off(event: "accountChanged", listener: (key: unknown) => void): void;
};

// Phantom-only provider uses wallet-adapter-react's base provider. The mobile
// auto-discovery provider brings local signing code that this app never needs.
export function WalletProvider({ children }: { children: ReactNode }) {
  const adapter = useMemo(() => new PhantomWalletAdapter(), []);
  const wallets = useMemo(() => [adapter], [adapter]);
  const isUnloadingRef = useRef(false);
  useEffect(() => {
    let phantom: PhantomEvents | undefined;
    const onAccountChanged = (key: unknown) => {
      // This pinned adapter expects a key and cannot handle Phantom's null
      // accountChanged payload. End that session and wait for an explicit connect.
      if (!key) void adapter.disconnect().catch(() => {});
    };
    const detach = () => { phantom?.off("accountChanged", onAccountChanged); phantom = undefined; };
    const attach = () => {
      detach();
      const injected = window as Window & { phantom?: { solana?: PhantomEvents }; solana?: PhantomEvents };
      phantom = injected.phantom?.solana ?? injected.solana;
      phantom?.on("accountChanged", onAccountChanged);
    };
    adapter.on("connect", attach);
    adapter.on("disconnect", detach);
    if (adapter.connected) attach();
    return () => { detach(); adapter.off("connect", attach); adapter.off("disconnect", detach); };
  }, [adapter]);
  // Adapter errors also describe background lifecycle events, including a
  // normal Phantom account switch. App reports explicit connect/sign failures.
  return <WalletProviderBase wallets={wallets} adapter={adapter} isUnloadingRef={isUnloadingRef}
    onSelectWallet={() => {}} onConnectError={() => {}} onError={() => {}}>
    {children}
  </WalletProviderBase>;
}
