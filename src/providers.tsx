import { ClientProvider } from "@solana/react";
import type { PropsWithChildren } from "react";
import { solanaClient } from "./client";

export function Providers({ children }: PropsWithChildren) {
  return <ClientProvider client={solanaClient}>{children}</ClientProvider>;
}
