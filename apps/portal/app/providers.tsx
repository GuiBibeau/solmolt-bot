"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import type { ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return children;

  return (
    <PrivyProvider
      appId={appId}
      config={{
        // Let the Privy dashboard decide which social/email providers are enabled.
        // Passing disallowed providers here causes 403s (e.g. "Login with Google not allowed").
        wallets: {
          walletChainType: "solana-only",
          showWalletLoginFirst: true,
        },
        appearance: {
          theme: "light",
          accentColor: "#ff7ac8",
          logo: undefined,
        },
        embeddedWallets: {
          createOnLogin: "off",
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
