export interface PlayerPageCase {
  url: string;
  namespace: string;
  draft: number;
  packaging: string;
  latency?: string;
  profile?: { latency?: string } | null;
  auto?: boolean;
  level?: number;
}
export interface BroadcasterPageCase {
  namespace: string;
  packaging: string;
  relayInfo: { url: string; publishDraft: number };
  params: { height: number; fps: number; bitrate: number; target: number };
}
export interface SoakProfile {
  variant?: string;
  broadcastQuery?: Record<string, string | number>;
  [key: string]: unknown;
}

export function playerPageQuery(c: PlayerPageCase, extra?: string): URLSearchParams;
export function variantProfile(cases: { profiles: Record<string, SoakProfile> }, variant: string): SoakProfile & { name: string };
export function broadcasterPageQuery(b: BroadcasterPageCase, variantQuery?: Record<string, string | number>): URLSearchParams;
