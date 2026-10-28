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
MTT_API_KEY=… pnpm test:player:soak --mtt --minutes 5
# one case
MTT_API_KEY=… pnpm test:player:soak --mtt --minutes 5 --only aiomoqt-relay:cmaf
# a synthetic g5-broadcast (generated fake camera and microphone) and its player
pnpm test:player:soak --broadcaster aiomoqt-relay:loc --tag t1 &
pnpm test:player:soak --broadcast-player aiomoqt-relay:loc --tag t1
```

Relays, packagings and the test-track namespaces are in `cases.json` (a case
with an `id` and its own `namespace` is a clip; `--only RELAY:ID`); each
relay's `playDrafts` lists the drafts its players use (draft 18 against the
draft-22 relay is the relay-versus-draft A/B). Synthetic broadcasts publish as
`ci/player-soak/<run>/<relay>/<packaging>`. `--skip-build` reuses built
workspace packages.

When the relay pauses a broadcast after its viewers leave (video Forward State 0
at least 30 s after it went live), the broadcaster job opens one 30 s viewer,
`rejoin-g5-<packaging>-<relay>-d<draft>`, which has to resume it. Its row adds
click → resume and resume → playing times; a broadcast never paused reports
`not paused`, which does not fail.

Evidence goes to `reports/player-soak/<run>/`: per case `samples.jsonl`,
`ticks.jsonl`, `console.jsonl` and `summary.json`; per run `summary.json` and
`summary.md`. Metrics: startup time, stalls and rebuffer ratio, frozen picture,
audio gaps, frame rate per minute, latency p50/p95/max per minute and its
drift, and the player's dropped frames, audio underruns, gaps, A/V skew and
cushion. Report-only, except that the run fails when a case does not play, or
when its catalog lists an audio track that is never heard (`no-audio`).

## Adverse profiles

`--profile NAME` plays each broadcast it is given (comma-separated, one after
another, first play draft only) under a profile from `cases.json`:

| profile | what |
|---|---|
| `lossy` | 2% loss, 40 ± 10 ms each way |
| `jitter` | 60 ± 20 ms, normal distribution (reorders) |
| `capped` | 3 Mbit/s down with a 200-packet queue, 30 ms each way |
| `wifi` | netem slots (bursts every 20–60 ms), 0.5% loss |
| `blackouts` | all relay traffic dropped for 3 s at 30 s and 10 s at 75 s |
| `hidden-tab` | tab hidden for 5 s at 30 s and 20 s at 75 s |
| `republish` | plays `…/<packaging>/restart`, whose broadcaster (`--variant restart`) stops and starts every `restartEveryS` |

Shaping uses `tc` netem through sudo (`impair.mjs`): only traffic with the
relays' IPv4 addresses, ingress through an IFB device. It is for disposable CI
runners, never a shared host. A hidden tab is a page brought to front over the
player, or an emulated visibility state where headless Chrome keeps the covered
page visible (`method` in the evidence).

Per disruption (or, without scheduled ones, per frozen picture; one still open
in the run's last 15 s is left out) the summary
gives the first fresh frame after it ends, the picture outage, and when video
latency settles: 5 s in a row within 1.2 × its pre-disruption median + 50 ms.
It also gives the startup breakdown (transport, setup, catalog, first object,
first frame, ms after load). A profile case fails as `unrecovered` when no fresh
frame follows a disruption.

```bash
pnpm test:player:soak --broadcaster aiomoqt-relay:cmaf --tag t1 --adverse-minutes 3 &
pnpm test:player:soak --broadcast-player aiomoqt-relay:cmaf --tag t1 --profile blackouts --minutes 3
```

CI: `.github/workflows/player-soak.yml`, on demand and nightly; it needs the
`MTT_API_KEY` repository secret (a moq-test-tracks key with the `run` role).
Each profile gets one runner for the `adverse.broadcasts`; a pull request runs
only the profiles marked `smoke`.
