/**
 * moq-test-tracks service client: start a job for a namespace on a relay, wait
 * for it to run, stop it. A 429 (over a cap) is retried until `deadlineMs`.
 */

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export class MttClient {
  constructor({ base = 'https://moq-test.ci.openmoq.org', key, fetchImpl = fetch } = {}) {
    if (!key) throw new Error('MTT_API_KEY is not set');
    this.base = base.replace(/\/$/, '');
    this.key = key;
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json, text };
  }

  /** Start (or join) a job; resolves with the job once the service accepted it. */
  async start(job, { deadlineMs = Date.now() + 600_000, log = () => {} } = {}) {
    for (let delay = 5_000; ; delay = Math.min(delay * 2, 60_000)) {
      const { status, json, text } = await this.request('POST', '/api/v1/jobs', job);
      if (status === 201 || status === 200) return json;
      if ((status === 429 || status === 503) && Date.now() + delay < deadlineMs) {
        log(`test-tracks job ${status === 429 ? 'over a cap' : 'runner down'}; retrying in ${delay / 1000}s`);
        await sleep(delay);
        continue;
      }
      throw new Error(`test-tracks job refused: ${status} ${text.slice(0, 300)}`);
    }
  }

  async waitRunning(id, { timeoutMs = 600_000 } = {}) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let reply;
      try {
        reply = await this.request('GET', `/api/v1/jobs/${id}`);
      } catch (error) {
        if (Date.now() > end) throw error;
        await sleep(2_000);
        continue;
      }
      const { status, json, text } = reply;
      if (status >= 500 && Date.now() <= end) {
        await sleep(2_000);
        continue;
      }
      if (status !== 200) throw new Error(`test-tracks job ${id}: ${status} ${text.slice(0, 300)}`);
      if (json.state === 'running') return json;
      if (['failed', 'stopped', 'done', 'expired'].includes(json.state)) {
        throw new Error(`test-tracks job ${id} ended before running: ${json.state} ${json.error ?? ''}`);
      }
      if (Date.now() > end) throw new Error(`test-tracks job ${id} not running after ${timeoutMs / 1000}s (${json.state})`);
      await sleep(2_000);
    }
  }

  async stop(id) {
    const { status, text } = await this.request('DELETE', `/api/v1/jobs/${id}`);
    if (status >= 400 && status !== 404) throw new Error(`test-tracks stop ${id}: ${status} ${text.slice(0, 300)}`);
  }
}
