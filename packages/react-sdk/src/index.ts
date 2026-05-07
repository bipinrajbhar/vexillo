// @vexillo/react-sdk — React bindings

export { createVexilloClient } from "./client";
export type {
  VexilloClient,
  VexilloClientConfig,
  ClientStatus,
} from "./client";

export { VexilloClientProvider } from "./provider";
export type { VexilloClientProviderProps } from "./provider";

export { useFlag } from "./use-flag";
export { useVexilloClient } from "./use-vexillo-client";

export { fetchFlags } from "./fetch-flags";

export { createMockVexilloClient } from "./testing";
export type { MockVexilloClientOptions } from "./testing";
