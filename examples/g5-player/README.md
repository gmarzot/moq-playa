# G5 Broadcast and Player

Two pages for testing live MoQT media in the browser:

- `/g5-broadcast/` publishes a camera or screen over WebTransport.
- `/g5-player/` plays a broadcast, with health counters, latency charts and the catalog.

Both pages are deployed at https://aiomoqt-relay.marzresearch.net/. That relay is for
light testing only.

## Acknowledgements

G5 is built on [moq-playa](https://github.com/openmoq/moq-playa), the OpenMOQ player
framework by Raymond Lucke and the Red5 team. Our thanks to Raymond in particular, and
to moq-playa contributors Paul Gregoire, Todd Anderson, Victoria Tournier,
Vojtech Zalesky and Abhay.

G5 also builds on approaches from Paul Gregoire's [moqxr](https://github.com/openmoq/moqxr),
[msfts](https://github.com/mondain/msfts) and
[MoQ contribution interop runner](https://github.com/mondain/moq-contribution-interop-runner).
