import React from "react";
import { VexilloClientProvider, type VexilloClient } from "@vexillo/react-sdk";
import { FlagCard } from "./components/FlagCard";
import { ConnectionStatus } from "./components/ConnectionStatus";

interface AppProps {
  client: VexilloClient;
  flagKeys: string[];
}

export function App({ client, flagKeys }: AppProps) {
  return (
    <VexilloClientProvider client={client} streaming>
      <main
        style={{ fontFamily: "sans-serif", padding: "2rem", maxWidth: "600px" }}
      >
        <h1 style={{ marginBottom: "0.5rem" }}>Vexillo SDK Demo</h1>
        <ConnectionStatus />
        <section style={{ marginTop: "1.5rem" }}>
          {flagKeys.length === 0 ? (
            <p>No flag keys configured. Set VITE_FLAG_KEYS in .env.</p>
          ) : (
            flagKeys.map((key) => <FlagCard key={key} flagKey={key} />)
          )}
        </section>
      </main>
    </VexilloClientProvider>
  );
}
