// @vitest-environment node
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VexilloProvider } from "../provider";
import { useFlag } from "../use-flag";

function Child() {
  const enabled = useFlag("some-flag");
  return <div>{String(enabled)}</div>;
}

describe("SSR smoke test", () => {
  it("renders the provider tree in a Node environment without throwing", () => {
    expect(() =>
      renderToStaticMarkup(
        <VexilloProvider
          baseUrl="https://vexillo.example.com"
          apiKey="sdk-key"
          fallbacks={{ "some-flag": true }}
        >
          <Child />
        </VexilloProvider>,
      ),
    ).not.toThrow();
  });

  it("uses fallback values on the server (before any fetch)", () => {
    const html = renderToStaticMarkup(
      <VexilloProvider
        baseUrl="https://vexillo.example.com"
        apiKey="sdk-key"
        fallbacks={{ "some-flag": true }}
      >
        <Child />
      </VexilloProvider>,
    );

    expect(html).toContain("true");
  });
});
