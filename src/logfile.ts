// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.ts";

const NAME = /^supa-visa-(\d{8}T\d{9}Z)(?:-(\d+))?\.log$/;

export interface RotatingLogOptions {
  readonly directory: string;
  // Total size kept on disk; the oldest segments are deleted beyond it.
  readonly maxBytes: number;
  readonly segments?: number;
  readonly clock: Clock;
  // Told about write failures; logging must never take a request down with it.
  readonly onError?: (error: unknown) => void;
}

// Appends lines to a set of segment files and keeps only the newest `maxBytes`.
// Writes are synchronous so lines never interleave and nothing is lost on a crash
// that follows a write; each line is small and the traffic is one owner's.
export class RotatingLogFile {
  private readonly options: RotatingLogOptions;
  private readonly segmentBytes: number;
  private fd: number | undefined;
  private current: string | undefined;
  private currentBytes = 0;

  constructor(options: RotatingLogOptions) {
    this.options = options;
    this.segmentBytes = Math.max(1024, Math.floor(options.maxBytes / (options.segments ?? 8)));
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    chmodSync(options.directory, 0o700);
    const newest = this.files().at(-1);
    if (newest !== undefined && newest.size < this.segmentBytes) {
      this.open(newest.name);
      this.currentBytes = newest.size;
    }
  }

  write(line: string): void {
    const data = Buffer.from(`${line}\n`, "utf8");
    try {
      if (this.fd === undefined || this.currentBytes + data.length > this.segmentBytes) this.rotate();
      writeSync(this.fd as number, data);
      this.currentBytes += data.length;
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = undefined;
  }

  // Segment files, oldest first. Names sort by the time they were started.
  files(): { name: string; size: number }[] {
    return readdirSync(this.options.directory)
      .filter((name) => NAME.test(name))
      .sort()
      .map((name) => ({ name, size: statSync(join(this.options.directory, name)).size }));
  }

  private rotate(): void {
    this.close();
    const stamp = new Date(this.options.clock()).toISOString().replace(/[-:.]/g, "");
    // A zero-padded counter keeps segments started in the same millisecond in order.
    // Past the highest counter, not the lowest free one: pruning frees low ones.
    let counter = 0;
    for (const file of this.files()) {
      const match = NAME.exec(file.name);
      if (match?.[1] === stamp) counter = Math.max(counter, Number(match[2] ?? 0) + 1);
    }
    const name = `supa-visa-${stamp}-${String(counter).padStart(4, "0")}.log`;
    this.open(name);
    this.currentBytes = 0;
    this.prune();
  }

  private open(name: string): void {
    this.fd = openSync(join(this.options.directory, name), "a", 0o600);
    this.current = name;
  }

  // The segment being written counts as full, so the total never exceeds maxBytes.
  private prune(): void {
    const others = this.files().filter((file) => file.name !== this.current);
    let total = others.reduce((sum, file) => sum + file.size, 0) + this.segmentBytes;
    for (const file of others) {
      if (total <= this.options.maxBytes) break;
      rmSync(join(this.options.directory, file.name), { force: true });
      total -= file.size;
    }
  }
}
