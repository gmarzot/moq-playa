/**
 * The page's build identity (package version + git commit, `-dirty` for an
 * uncommitted tree) and a check for a newer deploy. A deployed site serves
 * `/VERSION` as `moq-playa <build> <built-at ISO 8601>`; the dev server has none.
 */

declare const __PLAYA_BUILD__: string;
declare const __PLAYA_BUILT_AT__: string;

export const PAGE_BUILD: string = typeof __PLAYA_BUILD__ === 'string' ? __PLAYA_BUILD__ : 'unknown';
/** When this page was built (ISO 8601), or null outside a Vite build. */
export const PAGE_BUILT_AT: string | null = typeof __PLAYA_BUILT_AT__ === 'string' ? __PLAYA_BUILT_AT__ : null;

/** The build and, when known, its build time in the viewer's locale. */
export function describeBuild(build = PAGE_BUILD, builtAt = PAGE_BUILT_AT): string {
  if (!builtAt) return build;
  const when = new Date(builtAt);
  if (Number.isNaN(when.getTime())) return build;
  return `${build} · built ${when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
}

const BUILD_PATTERN = /^\d+\.\d+\.\d+[^\s+]*\+[0-9a-f]{7,}(-dirty)?$/;

export interface SiteVersion {
  readonly build: string;
  /** Build time in ms since the epoch, or null when `/VERSION` carries none. */
  readonly builtAtMs: number | null;
}

/** The build (and build time) named by a `/VERSION` body, or null if it names none. */
export function parseSiteVersion(text: string): SiteVersion | null {
  const tokens = text.trim().split(/\s+/);
  const i = tokens.findIndex((t) => BUILD_PATTERN.test(t));
  if (i < 0) return null;
  const at = tokens[i + 1] === undefined ? NaN : Date.parse(tokens[i + 1]!);
  return { build: tokens[i]!, builtAtMs: Number.isNaN(at) ? null : at };
}

/** Fill every `[data-build]` element with this page's build. */
export function showBuild(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-build]')) el.textContent = describeBuild();
}

export interface WatchSiteBuildOptions {
  readonly intervalMs?: number;
  readonly url?: string;
  readonly fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  /** This page's build and build time; default the baked-in values. */
  readonly pageBuild?: string;
  readonly pageBuiltAt?: string | null;
}

/**
 * Poll `/VERSION`; `onNewer` fires once the site serves a different build that
 * was built later than this page, read the same on two polls in a row (a deploy
 * in progress can briefly pair new pages with an old `/VERSION`). Without both
 * build times nothing is reported. Returns a stop function; failures stay quiet.
 */
export function watchSiteBuild(
  onNewer: (build: string) => void,
  options: WatchSiteBuildOptions = {},
): () => void {
  const url = options.url ?? '/VERSION';
  const fetchFn = options.fetchFn ?? ((u, init) => fetch(u, init));
  const pageBuild = options.pageBuild ?? PAGE_BUILD;
  const pageBuiltAt = options.pageBuiltAt === undefined ? PAGE_BUILT_AT : options.pageBuiltAt;
  const pageAtMs = pageBuiltAt === null ? NaN : Date.parse(pageBuiltAt);
  let stopped = false;
  let candidate: string | null = null;
  const check = async (): Promise<void> => {
    try {
      const res = await fetchFn(url, { cache: 'no-store' });
      if (!res.ok) return;
      const site = parseSiteVersion(await res.text());
      if (stopped) return;
      const newer = site !== null && site.build !== pageBuild && site.builtAtMs !== null
        && !Number.isNaN(pageAtMs) && site.builtAtMs > pageAtMs;
      if (!newer) {
        candidate = null;
        return;
      }
      if (candidate !== site.build) {
        candidate = site.build;
        return;
      }
      stopped = true;
      clearInterval(timer);
      onNewer(site.build);
    } catch { /* offline or blocked: try again next interval */ }
  };
  const timer = setInterval(() => { void check(); }, options.intervalMs ?? 60_000);
  void check();
  return () => { stopped = true; clearInterval(timer); };
}

/**
 * Show this page's build in every `[data-build]` element and the log, and
 * reveal `#build-update` (click reloads) once a newer build is deployed.
 */
export function initBuildInfo(log: (msg: string) => void): void {
  showBuild();
  log(`Build ${describeBuild()}`);
  const notice = document.getElementById('build-update');
  watchSiteBuild((site) => {
    log(`New build ${site} deployed; this page runs ${PAGE_BUILD}. Reload to update.`);
    if (!notice) return;
    notice.textContent = `new build ${site} — reload`;
    notice.title = `This page runs ${PAGE_BUILD}`;
    notice.hidden = false;
    notice.addEventListener('click', (e) => { e.preventDefault(); location.reload(); });
  });
}
