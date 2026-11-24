#!/usr/bin/env bash
# Copyright 2026 Kong Weirui
# SPDX-License-Identifier: MIT

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ -d node_modules ] || npm ci

echo "==> Type check"
npm run --silent typecheck

echo "==> Tests"
npm test --silent

echo "==> All tests passed"
