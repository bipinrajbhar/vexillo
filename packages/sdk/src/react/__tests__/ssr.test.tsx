// @vitest-environment node
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TogglrProvider } from "../provider";
import { useFlag } from "../use-flag";

function Child() {
  const enabled = useFlag("some-flag");
  return <div>{String(enabled)}</div>;
}

describe("SSR smoke test", () => {
  it("renders the provider tree in a Node environment without throwing", () => {
    expect(() =>
      renderToStaticMarkup(
        <TogglrProvider
          baseUrl="https://togglr.example.com"
          apiKey="sdk-key"
          environment="production"
          fallbacks={{ "some-flag": true }}
        >
          <Child />
        </TogglrProvider>,
      ),
    ).not.toThrow();
  });

  it("uses fallback values on the server (before any fetch)", () => {
    const html = renderToStaticMarkup(
      <TogglrProvider
        baseUrl="https://togglr.example.com"
        apiKey="sdk-key"
        environment="production"
        fallbacks={{ "some-flag": true }}
      >
        <Child />
      </TogglrProvider>,
    );

    expect(html).toContain("true");
  });
});
