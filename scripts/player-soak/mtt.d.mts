export class MttClient {
  constructor(options?: { base?: string; key?: string; fetchImpl?: typeof fetch });
  start(job: Record<string, unknown>, options?: { deadlineMs?: number; log?: (message: string) => void }): Promise<any>;
  waitRunning(id: string, options?: { timeoutMs?: number }): Promise<any>;
  stop(id: string): Promise<void>;
}
