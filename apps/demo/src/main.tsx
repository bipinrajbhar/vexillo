import React from "react";
import ReactDOM from "react-dom/client";
import { createVexilloClient } from "@vexillo/react-sdk";
import { App } from "./App";

const client = createVexilloClient({
  baseUrl: import.meta.env.VITE_BASE_URL ?? "",
  apiKey: import.meta.env.VITE_API_KEY ?? "",
});

const flagKeys = (import.meta.env.VITE_FLAG_KEYS ?? "")
  .split(",")
  .map((k: string) => k.trim())
  .filter(Boolean);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App client={client} flagKeys={flagKeys} />
  </React.StrictMode>,
);
