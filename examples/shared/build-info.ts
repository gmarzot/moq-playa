/**
 * The page's build identity (package version + git commit, `-dirty` for an
 * uncommitted tree) and a check for a newer deploy. A deployed site serves
 * `/VERSION` as `moq-playa <build>`; the dev server has none.
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

/** The build named by a `/VERSION` body, or null if it names none. */
export function parseSiteVersion(text: string): string | null {
  const last = text.trim().split(/\s+/).pop() ?? '';
  return BUILD_PATTERN.test(last) ? last : null;
}

/** Fill every `[data-build]` element with this page's build. */
export function showBuild(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-build]')) el.textContent = describeBuild();
}

export interface WatchSiteBuildOptions {
  readonly intervalMs?: number;
  readonly url?: string;
  readonly fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * Poll `/VERSION`; `onNewer` fires once when the site serves another build.
 * Returns a stop function. Failures and pages without `/VERSION` stay quiet.
 */
export function watchSiteBuild(
  onNewer: (build: string) => void,
  options: WatchSiteBuildOptions = {},
): () => void {
  const url = options.url ?? '/VERSION';
  const fetchFn = options.fetchFn ?? ((u, init) => fetch(u, init));
  let stopped = false;
  const check = async (): Promise<void> => {
    try {
      const res = await fetchFn(url, { cache: 'no-store' });
      if (!res.ok) return;
      const site = parseSiteVersion(await res.text());
      if (stopped || site === null || site === PAGE_BUILD) return;
      stopped = true;
      clearInterval(timer);
      onNewer(site);
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
