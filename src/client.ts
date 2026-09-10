import { createClient } from "@solana/kit";
import { solanaRpc } from "@solana/kit-plugin-rpc";
import { walletSigner } from "@solana/kit-plugin-wallet";
import { DEVNET_RPC } from "./lib/constants";

export const solanaClient = createClient()
  .use(walletSigner({ chain: "solana:devnet" }))
  .use(solanaRpc({ rpcUrl: DEVNET_RPC }));

export type AppClient = Awaited<typeof solanaClient>;
