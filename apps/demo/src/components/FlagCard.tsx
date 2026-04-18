import React from "react";
import { useFlag } from "@vexillo/react-sdk";

interface FlagCardProps {
  flagKey: string;
}

export function FlagCard({ flagKey }: FlagCardProps) {
  const [value, isLoading] = useFlag(flagKey);
  return (
    <div
      style={{
        border: "1px solid #ddd",
        borderRadius: "8px",
        padding: "1rem",
        marginBottom: "0.75rem",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <span style={{ fontFamily: "monospace", fontWeight: 500 }}>{flagKey}</span>
      {isLoading ? (
        <span style={{ color: "#888" }} data-testid={`loading-${flagKey}`}>
          loading…
        </span>
      ) : (
        <span
          data-testid={`value-${flagKey}`}
          style={{ fontWeight: 700, color: value ? "#16a34a" : "#dc2626" }}
        >
          {value ? "ON" : "OFF"}
        </span>
      )}
    </div>
  );
}
