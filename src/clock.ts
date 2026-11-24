// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
