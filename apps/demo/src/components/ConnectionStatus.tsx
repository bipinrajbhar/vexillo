import React, { useEffect, useReducer } from "react";
import { useVexilloClient } from "@vexillo/react-sdk";

export function ConnectionStatus() {
  const client = useVexilloClient();
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    return client.subscribeAll(() => forceUpdate());
  }, [client]);

  return (
    <div style={{ fontSize: "0.875rem", color: "#555" }}>
      {client.isReady ? (
        <span style={{ color: "#16a34a" }}>● Connected</span>
      ) : (
        <span style={{ color: "#f59e0b" }}>● Connecting…</span>
      )}
      {client.lastError && (
        <span style={{ color: "#dc2626", marginLeft: "1rem" }}>
          Error: {client.lastError.message}
        </span>
      )}
    </div>
  );
}
