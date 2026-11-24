// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { SECOND } from "./duration.ts";
import type { Logger } from "./log.ts";
import type { SyncStatus } from "./sync.ts";

export interface HeartbeatOptions {
  readonly url: string;
  readonly status: () => SyncStatus;
  readonly logger: Logger;
  readonly fetch?: typeof fetch;
}

// Pings an outside monitor only while syncing works, so the monitor raises the
// alarm when Supa Visa is down or cannot reach Cloudflare: then expired visas
// may still be on the list.
export class Heartbeat {
  private readonly options: HeartbeatOptions;
  private failures = 0;

  constructor(options: HeartbeatOptions) {
    this.options = options;
  }

  async beat(): Promise<boolean> {
    const { lastSuccessAt, failingSince } = this.options.status();
    if (lastSuccessAt === undefined || failingSince !== undefined) return false;
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.url, { signal: AbortSignal.timeout(10 * SECOND) });
      if (response.ok) return true;
      this.failed(String(response.status));
    } catch (error) {
      this.failed(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network");
    }
    return false;
  }

  // The URL often carries a secret (push tokens), so it is never logged.
  private failed(status: string): void {
    if (this.failures++ % 10 === 0) this.options.logger.warn("heartbeat.failed", { status, failures: this.failures });
  }
}
