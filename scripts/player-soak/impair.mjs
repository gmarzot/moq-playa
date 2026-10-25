/**
 * Network impairment for a soak player on a disposable CI runner (Linux tc
 * netem, through sudo). Only traffic to and from the relays' addresses is
 * shaped: ingress through an IFB device, egress through a filtered prio band.
 */
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';

const IFB = 'ifbsoak';
const PASS = 'delay 0ms';

const sudo = (argv) => new Promise((resolve, reject) => {
  execFile('sudo', argv, (error, stdout, stderr) => {
    if (error) reject(new Error(`${argv.join(' ')}: ${(stderr || error.message).trim()}`));
    else resolve(stdout);
  });
});
const split = (netem) => netem.trim().split(/\s+/);

export class Impairment {
  constructor(dev, addresses) {
    this.dev = dev;
    this.addresses = addresses;
    this.profile = { down: PASS, up: PASS };
  }

  /** Resolve the relays' IPv4 addresses and the uplink device that reaches them. */
  static async forRelays(urls) {
    const hosts = [...new Set(urls.map((u) => new URL(u).hostname))];
    const addresses = [...new Set((await Promise.all(hosts.map((h) => lookup(h, { all: true, family: 4 }))))
      .flat().map((a) => a.address))];
    if (addresses.length === 0) throw new Error(`no IPv4 address for ${hosts.join(', ')}`);
    const route = await new Promise((resolve, reject) => execFile('ip', ['-o', 'route', 'get', addresses[0]],
      (e, out) => (e ? reject(e) : resolve(out))));
    const dev = / dev (\S+)/.exec(route)?.[1];
    if (!dev) throw new Error(`no route device for ${addresses[0]}: ${route.trim()}`);
    return new Impairment(dev, addresses);
  }

  async setup() {
    await sudo(['modprobe', 'ifb']).catch(async () => {
      await sudo(['apt-get', 'install', '-y', '-q', `linux-modules-extra-${(await sudo(['uname', '-r'])).trim()}`]);
      await sudo(['modprobe', 'ifb']);
    });
    await sudo(['ip', 'link', 'add', IFB, 'type', 'ifb']);
    await sudo(['ip', 'link', 'set', IFB, 'up']);
    await sudo(['tc', 'qdisc', 'add', 'dev', this.dev, 'handle', 'ffff:', 'ingress']);
    await sudo(['tc', 'qdisc', 'add', 'dev', IFB, 'root', 'netem', ...split(PASS)]);
    // Band 4 takes only the filtered relay traffic; the priomap keeps the rest in 1-3.
    await sudo(['tc', 'qdisc', 'add', 'dev', this.dev, 'root', 'handle', '1:', 'prio', 'bands', '4',
      'priomap', '1', '2', '2', '2', '1', '2', '0', '0', '1', '1', '1', '1', '1', '1', '1', '1']);
    await sudo(['tc', 'qdisc', 'add', 'dev', this.dev, 'parent', '1:4', 'handle', '40:', 'netem', ...split(PASS)]);
    for (const a of this.addresses) {
      await sudo(['tc', 'filter', 'add', 'dev', this.dev, 'parent', 'ffff:', 'protocol', 'ip', 'u32',
        'match', 'ip', 'src', `${a}/32`, 'action', 'mirred', 'egress', 'redirect', 'dev', IFB]);
      await sudo(['tc', 'filter', 'add', 'dev', this.dev, 'parent', '1:', 'protocol', 'ip', 'prio', '1', 'u32',
        'match', 'ip', 'dst', `${a}/32`, 'flowid', '1:4']);
    }
  }

  /** Shape relay traffic: `netem` both ways, or `down` / `up` per direction. */
  async apply(profile = {}) {
    this.profile = { down: profile.down ?? profile.netem ?? PASS, up: profile.up ?? profile.netem ?? PASS };
    await this.set(this.profile.down, this.profile.up);
  }

  /** Drop all relay traffic until restore(). */
  async blackout() {
    await this.set('loss 100%', 'loss 100%');
  }

  async restore() {
    await this.set(this.profile.down, this.profile.up);
  }

  async set(down, up) {
    await sudo(['tc', 'qdisc', 'replace', 'dev', IFB, 'root', 'netem', ...split(down)]);
    await sudo(['tc', 'qdisc', 'replace', 'dev', this.dev, 'parent', '1:4', 'handle', '40:', 'netem', ...split(up)]);
  }

  /** Kernel counters, for the case evidence. */
  async stats() {
    return {
      down: (await sudo(['tc', '-s', 'qdisc', 'show', 'dev', IFB])).trim(),
      up: (await sudo(['tc', '-s', 'qdisc', 'show', 'dev', this.dev, 'parent', '1:4'])).trim(),
    };
  }
}
