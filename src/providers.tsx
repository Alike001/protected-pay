import { createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { walletSigner } from "@solana/kit-plugin-wallet";
import { ClientProvider } from "@solana/react";
import type { PropsWithChildren } from "react";
import { DEVNET_RPC } from "./lib/constants";

export const solanaClient = createClient()
  .use(walletSigner({ chain: "solana:devnet" }))
  .use(solanaRpc({ rpcUrl: DEVNET_RPC }));

export type AppClient = Awaited<typeof solanaClient>;

export function Providers({ children }: PropsWithChildren) {
  return <ClientProvider client={solanaClient}>{children}</ClientProvider>;
}
