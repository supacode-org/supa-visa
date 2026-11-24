// Copyright 2026 Kong Weirui
// SPDX-License-Identifier: MIT

import packageJson from "../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;
