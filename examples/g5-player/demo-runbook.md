# G5 demo runbook

Demos centred on the two G5 pages: `/g5-broadcast/` (camera or screen →
relay) and `/g5-player/`. Publisher pipelines from aiomoqt tools into the
player (files, OBS over SRT, HLS/DASH) are in aiomoqt's
[demo runbook](https://github.com/gmarzot/aiomoqt/blob/main/docs/demo-runbook.md).

## Pages and relays

- Deployed: https://aiomoqt-relay.marzresearch.net/g5-broadcast/ and
  https://aiomoqt-relay.marzresearch.net/g5-player/.
- Local, with hot reload, from this repo:
  `pnpm install && pnpm --filter @moqt/examples dev` → http://localhost:5173/g5-broadcast/
  and http://localhost:5173/g5-player/.
- Relays (never restart either):

| Relay | WebTransport URL | Drafts |
|---|---|---|
| aiomoqt-relay | https://aiomoqt-relay.marzresearch.net:4443/ | 14, 16, 18, 22 |
| moqx-main | https://moqx-main.ci.openmoq.org:4433/moq-relay | 16, 18 |

- Clocks: both pages correct this machine's clock against the page host's
  `/time` (`?clockUrl=` overrides) and log the offset. Served from a host
  without `/time`, they use the machine clock and say so; latency between two
  machines is then only as good as their clocks.

## Broadcaster

**Start** opens the source menu (each camera, then the screen); one source
starts at once. While a broadcast runs the same button shows a red square and
stops it. **Viewer link** (chain icon) shows the player link, to copy or
open; it carries the relay, namespace, draft and any `compat=`. Settings (⚙) are kept per tab
across reloads and seed new tabs; a URL parameter overrides a saved value
(e.g. `packaging=cmaf`, `v=22`, `target=150`, `camera=back`).

| Setting | Meaning |
|---|---|
| Relay WebTransport URL | default moqx-main |
| Namespace | blank: a fresh `g5-<hex>` per broadcast, kept across reconnects (**New** mints one); a typed name is kept |
| Draft version | 18 (default), 22, 16, 14 |
| Packaging | LOC (default; WebCodecs on the viewer) · CMAF (fMP4, MSE) · LOCMAF (CMAF with compact headers, MSE) |
| Camera resolution | 1080p, 720p (default), 480p; screen capture keeps the screen size |
| Video codec, bitrate, bitrate mode | H.264 Baseline or High, AV1, HEVC, VP9 (unsupported codecs fall back to Baseline); 4500 / 2000 / 1000 kbps by resolution; constant mode tames keyframe bursts |
| Capture frame rate | requested (default 60); the camera may deliver less (`Video: … @ NNfps` in the log) |
| Audio codec | Opus (default) or AAC-LC, which needs an OS encoder (Windows, macOS) and falls back to Opus |
| Audio over datagrams | draft 18, LOC or CMAF |
| Target playback latency | the catalog `targetLatency` (default 200 ms): the viewer's playout target |
| Keyframe interval | seconds between keyframes (default 2) |
| Congestion control | browser default / low latency / throughput hint |
| Catalog refresh interval, delivery | re-send period (draft 18 viewers FETCH it); subscribe + FETCH (default), FETCH only, subscribe only |
| Advanced | dynamic groups, self-describing objects, LOC timescale, voice processing, H.264 Annex B, certificate hash, status overlay, verbose logging |

Readouts: SETUP / PUB_NS / per-track FWD badges (green = a relay
subscription forwarding); BITRATE A/V, FPS ENC, TARGET, OBJECTS A/V,
KEYFRAMES, QUEUE A/V, UPTIME. The log has each relay SUBSCRIBE, FETCH and
Forward State change, capture gaps, and the per-minute capture drift.

## Player

Controls: play/pause, timeline, speaker (on phones it opens a volume slider
with mute), ⚙ (View: every view of the catalog, grouped by program; Quality;
Audio: the program's audio feeds; Language: the languages of the feed playing;
Latency: Live edge or Smooth; Connection settings), catalog panel.
A view this browser cannot decode is listed as "not supported here" and
cannot be chosen.

Readouts: TTFF; BITRATE A/V; REORDER A/V; LAG; CLK DRIFT; SLOWEST T/A/D;
RESYNCS; UNDERRUNS; LATE/SNAP; DROPPED; OBJ LOST A/V; STALLS. LATENCY
p50/p95/max is capture → arrival, `E2E` capture → drawn frame (`≈` on MSE,
where it is arrival plus the buffer ahead); JITTER; QUEUED per track against
TARGET with the playback RATE. On CMAF/LOCMAF the log reports decode-order
repair (`audio order restored/missing/late`) and catch-up starts.

### URL parameters

The Connection settings dialog edits most of these; `nsField=`, `locmaf=`,
`compat=` and `clockUrl=` are set in the URL only. The page log prints
`Options: …` at load with what reached the engine.

| Param | Meaning | Default |
|---|---|---|
| `url=` | relay WebTransport URL | this host's relay, else moqx-main |
| `ns=` | namespace, split on `/` (`nsField=` repeatable for literal fields) | `live` |
| `v=` | draft 14, 16, 18 or 22 | auto (offers 16) |
| `targetLatency=` | overrides the catalog target (ms); see below | catalog value |
| `latency=` | `live` or `smooth`; the ⚙ menu sets it for this tab | live |
| `latencyMin=` | where Smooth starts and the lowest it steps back to (ms); 0 starts at the target | 1000 |
| `latencyMax=` | Smooth's limit (ms) | 2000 |
| `cushion=` / `cushionMax=` | LOC render-cushion floor / cap (ms) | 200 (50 under 5 ms RTT) / min(target, 750) |
| `catchUp=` | LOC max playback rate chasing the target | 1.0 (off) |
| `catalogBootstrap=` | auto, joining-fetch, strict, subscribe, fetch | auto |
| `warmStart=0` | off: LOC no longer fetches the current group, CMAF/LOCMAF no longer ask for a new one | on |
| `autoResume=0` | off: a hidden tab waits until it is viewed, retries after a relay refusal included | on |
| `locmaf=frame` | LOCMAF through WebCodecs instead of MSE | MSE |
| `congestionControl=` | `low-latency` / `throughput` hint to the browser's QUIC | browser default |
| `compat=` | `request-credit`, `empty-objects`: leniency for non-conformant relays | none |
| `authority=` | CLIENT_SETUP AUTHORITY for tenant-routed relays | none |
| `hash=` | relay certificate hash (hex) | none |
| `clockUrl=` | clock reference | the page host's `/time` |
| `debug=1` | engine debug log, MSE tracing, media-element events | off |
| `status=1` | playback state over the picture | off |

On drafts 18 and 22 the page follows the namespace with SUBSCRIBE_NAMESPACE
(SUB_NS badge): a publisher that goes away and returns is re-joined without
a reload.

### Latency target and cushion

- CMAF and LOCMAF hold the target as buffer ahead of the playhead, at least
  140 ms because Chrome's MSE stalls below that; catch-up (1.05×) sheds
  anything above it, and live-edge and gap-jump seeks land there. To run 2 s
  behind live: `targetLatency=2000`.
- LOC plays a render cushion between a floor and a cap, and the target only
  caps it. To run 2 s behind live on LOC, raise the floor too:
  `targetLatency=2000&cushion=2000`.
- ⚙ → Latency: **Live edge** (default) keeps the target and skips media that
  arrives late. **Smooth** starts 1 s behind live (`latencyMin=`), raises the
  delay when media arrives late, by how late it was plus 50 ms, up to its
  limit (2 s, `latencyMax=`), and steps back toward 1 s after 30 s with
  nothing late. TARGET then shows the delay in force, and the log records
  each raise and step-down. The choice applies after a reload.

## Samples to play

These streams are turned on separately when a demo needs them, so they may
be down; check before a demo. Each carries video, audio and an MSF catalog.

| Namespace | Relay | Packaging |
|---|---|---|
| `openmoq/ffmpeg/artemis` | aiomoqt-relay, draft 18 | LOC, multitrack |
| `openmoq/aiomoqt/mtt_00/artemis_directors/loc/h264/1080/30/aac/2` | aiomoqt-relay | LOC |
| `openmoq/aiomoqt/mtt_00/bbb_4k30/cmaf/h264/1080/30/aac/2` | aiomoqt-relay | CMAF |
| `openmoq/aiomoqt/mtt_00/bbb_4k30/cmaf/h264/1080/30/aac/2` | moqx-main (optional) | CMAF |

Play with the relay given: `/g5-player/?url=https://aiomoqt-relay.marzresearch.net:4443/&ns=<namespace>&v=22`
(`v=18` for moqx-main and for `openmoq/ffmpeg/artemis`). Without `url=` the
page looks for a relay on port 4433 of its host and falls back to moqx-main.

`openmoq/ffmpeg/artemis` is the FFmpeg multitrack Artemis II set: two views in
Program 1 (NASA TV, Director's cut) and seven cameras in Program 2, one of them
H.265 and one AV1; English, Spanish, commentary (Opus) and liftoff-call audio.
The player takes one video and one audio at a time: ⚙ → View lists all nine
views by program (picking a view in the other program switches both); ⚙ →
Audio picks NASA TV, Commentary or Liftoff call, and ⚙ → Language picks English
or Español for NASA TV. An H.265 camera is listed as
not supported where the browser cannot decode H.265.

When one is not running, generate it yourself with the
[moq-test-tracks](https://github.com/openmoq/moq-test-tracks) generator, under
a prefix of your own, then play that namespace. A clip's first run renders its
loop, which can take a minute.

```
mtt media fetch bbb_4k30
mtt run --relay moqt://aiomoqt-relay.marzresearch.net:4443 --draft 22 --ns <you>/mtt_00/bbb_4k30/cmaf/h264/1080/30/aac/2 --ttl 3600
mtt run --relay moqt://aiomoqt-relay.marzresearch.net:4443 --draft 22 --ns <you>/mtt_00/clock/loc/h264/720/30/aac/2 --ttl 3600
```

The artemis_directors clip is built from local demo-set files (ask for them);
the clock stream above is the LOC sample anyone can generate.

## Part 1 — browser only

### G1 — LOC basics
- Broadcast with defaults (LOC, draft 18, target 200), open the viewer link.
- Expect TTFF under 1 s, LATENCY p50 about 50 ms, E2E near target + capture
  + encode, stalls 0.

### G2 — LOC, CMAF and LOCMAF side by side
- Two more broadcaster tabs: ⚙ → Packaging CMAF, and LOCMAF → Apply
  (settings are per tab). Open the three viewer links next to each other.
- Expect CMAF and LOCMAF a little above LOC. MSE holds its buffer at the
  target; at 24 fps it stalls with about 100–150 ms buffered, so a target
  below ~150 ms cycles stall → refill → catch-up.

### G3 — many viewers, late joins
- Open three or four viewer tabs, a few seconds apart.
- Each joins with SUBSCRIBE plus a Joining FETCH (LOC) or a new group
  (CMAF/LOCMAF, with dynamic groups): one `FETCH served` line per LOC viewer
  in the broadcaster log. The relay carries one subscription per track
  upstream.

### G4 — pause and resume
- Player pause / play. As the only viewer, the broadcaster logs
  `Forward State 0`, then `1`, and forces a keyframe on resume.
- Expect playback to resume at live. On CMAF the order line stays at
  `missing 0`: the paused interval is not counted as lost.

### G5 — leave, return, restart
- Close a viewer: its session closes at once; media FWD goes grey when the
  last one leaves.
- Stop (the red square) sends PUBLISH_DONE on each subscription and withdraws
  the namespace before the session closes.
- Typed namespace: Stop, then start again. An open viewer re-joins on its own
  when the namespace is published again (SUB_NS).
- Blank namespace: each start mints a new one; open the new viewer link.

### G6 — latency targets
- Target 200 → 150 → 100 (broadcaster setting, or `targetLatency=` on a
  single viewer). Watch QUEUED against TARGET, STALLS and the catch-up line.
  CMAF and LOCMAF hold 140 ms at the lowest, which TARGET shows.
- 2 s behind live: see [Latency target and cushion](#latency-target-and-cushion).
- 60 fps: Screen with capture rate 60 (check the `Video:` log line).

### G7 — drafts
- Draft 14 or 16 broadcaster: the viewer link adds
  `catalogBootstrap=subscribe`; SUB_NS stays grey (not sent before 18).
- Draft 22: on aiomoqt-relay only (moqx-main speaks 16 and 18).

### G8 — transport knobs
- Congestion control low latency vs throughput, and audio over datagrams
  (draft 18): A/B two broadcaster tabs and compare JITTER and UNDERRUNS.

### G9 — non-conformant relay
- `?compat=request-credit,empty-objects` on both pages: requests without
  initial MAX_REQUEST_ID credit, and empty media objects skipped. The player
  logs a `compat:` line with what it had to tolerate.

## Part 2 — with aiomoqt tools

Shell setup (aiomoqt checkout, venv, `RELAY_WT`): "Before anything" in
aiomoqt's [demo runbook](https://github.com/gmarzot/aiomoqt/blob/main/docs/demo-runbook.md).
The g5 namespace is one field (`g5-<hex>`), shown in each page's header
(click to copy); pass it with `-N` as is.

### M1 — browser broadcaster → aiomoqt subscriber
- `python -m aiomoqt.tools.sub_media "$RELAY_WT" --draft 18 -N g5-<hex> --analyze -i 1 --report g5.csv`
- Per-track delivery, pacing and capture → arrival latency, independent of
  the player. Read the clock note below before comparing latencies.

### M2 — aiomoqt publisher → browser player
- With `AIOMOQT_PLAYER_URL` set, `pub_media` prints a `/g5-player/` URL per
  relay: demos A–C in aiomoqt's demo runbook.
- moq-test-tracks streams generated locally, with aiomoqt checks on the wire:
  [demo G](https://github.com/gmarzot/aiomoqt/blob/gmarzot-0.15.0/docs/demo-runbook.md#demo-g--moq-test-tracks-streams-generated-locally-no-token)
  in aiomoqt's demo runbook (on the 0.15.0 branch until that release).

### M3 — path canary next to a g5 pair
- Publisher first, then subscriber, while a G1/G2 pair runs:
- `python -m aiomoqt.tools.pub_bench "$RELAY_WT" --draft 18 -N canary -T video --video 1080p -r 30 -t 3600`
- `python -m aiomoqt.tools.sub_bench "$RELAY_WT" --draft 18 -N canary -T video -i 1`
- A spike on the g5 pair alone is the pair; one in both at the same moment is
  the path or the host.

### M4 — one broadcast, mixed audience
- One g5 broadcast; viewers: two player tabs plus M1's `sub_media`. The
  player LATENCY chart and the `sub_media` intervals cover the same objects.

## Clock note (WSL tools)

The pages correct their clocks against the page host; aiomoqt tools in WSL
read the WSL VM's clock, uncorrected. Before trusting a cross-host latency,
or when a WSL-side stream shows a periodic sawtooth:
- `cat /sys/devices/system/clocksource/clocksource0/current_clocksource`
- WSL clock against NTP, every 3 s (offset in ms, ±RTT/2):
  `for i in $(seq 30); do python -c 'import socket,struct,time;s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(2);s.sendto(b"\x1b"+47*b"\0",("time.google.com",123));w=struct.unpack("!12I",s.recv(48));print(round((w[10]-2208988800+w[11]/2**32-time.time())*1000,1))'; sleep 3; done`
  Healthy: the offset holds within a few tens of ms. Broken (2026-10-07): it
  climbed about 12 ms per second and dropped about 350 ms every 25–30 s as
  the host stepped the clock.
- Scheduling gaps in the WSL VM over 2 min (gaps over 50 ms, with their time):
  `python -c "import time;s=p=time.monotonic();exec('while p-s<120:\n time.sleep(0.001);n=time.monotonic()\n if n-p>0.05: print(round(n-s,1),round((n-p)*1000))\n p=n')"`
- A steady offset reads as latency; a ramp with steps is a clock fault;
  regular gaps are VM pauses, which also stall the network.

## Known issues

- Namespace restarted under the same typed name on moqx-main: a new viewer can
  get no catalog, because moqx answers its FETCH from the earlier run's cache
  (openmoq/moqx#795). A blank namespace avoids it.
- moqx keeps the draft-18 catalog subscription after its viewers leave
  (catalog FWD stays green).
- Hidden tabs: Chrome throttles timers; the player logs `Page hidden` /
  `Page visible after Ns away` to correlate.
