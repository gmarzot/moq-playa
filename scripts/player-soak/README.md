# Player soak

Plays live MoQT streams in headless Chrome, several minutes per case, and
records the whole run: the page's 250 ms playback samples (playhead, presented
frames, picture digest, audio level), and each second the player's stats,
its session and recovery events, and per-object latency from the objects'
capture times (draft-frindell timestamps, LOC Timestamp or prft).

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chrome
# moq-test-tracks streams, started through the service API
MTT_API_KEY=… pnpm test:player:soak --mtt --minutes 5 [--only aiomoqt-relay:cmaf]
# a synthetic g5-broadcast (fake camera and microphone, needs ffmpeg) and its player
pnpm test:player:soak --broadcaster aiomoqt-relay:loc --tag t1 &
pnpm test:player:soak --broadcast-player aiomoqt-relay:loc --tag t1
```

Relays, packagings and the test-track namespace are in `cases.json`; each
relay's `playDrafts` lists the drafts its players use (draft 18 against the
draft-22 relay is the relay-versus-draft A/B). Synthetic broadcasts publish as
`ci/player-soak/<run>/<relay>/<packaging>`. `--skip-build` reuses built
workspace packages.

Evidence goes to `reports/player-soak/<run>/`: per case `samples.jsonl`,
`ticks.jsonl`, `console.jsonl` and `summary.json`; per run `summary.json` and
`summary.md`. Metrics: startup time, stalls and rebuffer ratio, frozen picture,
audio gaps, frame rate per minute, latency p50/p95/max per minute and its
drift, and the player's dropped frames, audio underruns, gaps, A/V skew and
cushion. Report-only: the run fails only when a case does not play.

CI: `.github/workflows/player-soak.yml`, on demand and nightly; it needs the
`MTT_API_KEY` repository secret (a moq-test-tracks key with the `run` role).
