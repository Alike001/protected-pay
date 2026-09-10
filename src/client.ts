import { createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { walletSigner } from "@solana/kit-plugin-wallet";
import { SOLANA_DEVNET_RPC } from "./lib/constants";

export const solanaClient = createClient()
  .use(walletSigner({ chain: "solana:devnet" }))
  // Public custody, token transfers, and delegation setup live on Solana.
  // Every transaction builder in this app already supplies an explicit compute
  // budget. Disable the RPC plugin's provisional resource-limit instruction so
  // it cannot add a second compute limit and fail its estimation simulation.
  // Preflight remains enabled by default.
  .use(solanaRpc({
    rpcUrl: SOLANA_DEVNET_RPC,
    transactionConfig: { estimateResourceLimits: false },
  }));

export type AppClient = Awaited<typeof solanaClient>;
