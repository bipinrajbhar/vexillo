export type RegionFanout = (envId: string, payload: string) => void;

export function createRegionFanout(secondaryUrls: string[], secret: string): RegionFanout {
  if (secondaryUrls.length === 0) return () => {};

  return (envId: string, payload: string): void => {
    for (const baseUrl of secondaryUrls) {
      fetch(`${baseUrl}/internal/flag-change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': secret,
        },
        body: JSON.stringify({ envId, payload }),
      }).catch((err: unknown) => {
        console.error(
          `[region-fanout] Failed to notify ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  };
}

export function parseSecondaryUrls(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
