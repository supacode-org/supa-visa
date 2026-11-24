// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import { errorMessage, type Logger } from "./log.ts";
import { EMPTY_STATE, type State, type StateStore } from "./store.ts";

// The single owner of the in-memory state and the data file. Visas, services and
// passkeys share one file, so every change goes through one queue; otherwise two
// changes saved concurrently could each overwrite the other.
export class StateKeeper {
  private readonly store: StateStore;
  private readonly logger: Logger;
  private current: State = EMPTY_STATE;
  // Set when a change was applied in memory but could not be saved; retried later.
  private unsaved = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(store: StateStore, logger: Logger) {
    this.store = store;
    this.logger = logger;
  }

  get state(): State {
    return this.current;
  }

  async load(): Promise<void> {
    this.current = await this.store.load();
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.catch(() => {});
    return run;
  }

  // For changes requested from outside: they take effect only once they are on
  // disk, so a failed save leaves the state as it was. Call inside `exclusive`.
  async commit(next: State): Promise<void> {
    try {
      await this.store.save(next);
    } catch (error) {
      this.logger.error("store.save_failed", { error: errorMessage(error) });
      throw error;
    }
    this.current = next;
    this.unsaved = false;
  }

  // For changes that must take effect even if the disk fails (expiry, revoking
  // everything): applied in memory first, saved now or on a later `saveUnsaved`.
  // Call inside `exclusive`.
  async apply(next: State): Promise<void> {
    this.current = next;
    this.unsaved = true;
    await this.saveUnsaved();
  }

  // Call inside `exclusive`.
  async saveUnsaved(): Promise<void> {
    if (!this.unsaved) return;
    try {
      await this.store.save(this.current);
      this.unsaved = false;
    } catch (error) {
      this.logger.error("store.save_failed", { error: errorMessage(error) });
    }
  }

  async idle(): Promise<void> {
    await this.queue.catch(() => {});
    await this.store.flush().catch(() => {});
  }
}
