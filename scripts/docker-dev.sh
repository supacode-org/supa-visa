#!/usr/bin/env bash
# Copyright 2026 Kong Weirui
# SPDX-License-Identifier: MIT
#
# Runs Supa Visa in the local Docker for manual testing.
#
#   scripts/docker-dev.sh up      build the image and (re)start the container
#   scripts/docker-dev.sh logs    follow the container logs
#   scripts/docker-dev.sh down    stop and remove the container, keep the data volume
#   scripts/docker-dev.sh reset   down, then remove the data volume

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

image=supa-visa:dev
container=supa-visa-dev
volume=supa-visa-dev-data

down() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}

case "${1:-}" in
  up)
    [ -f .env ] || { echo "Missing .env; copy .env.example to .env first." >&2; exit 1; }
    docker build --tag "$image" .
    down
    docker run --detach --name "$container" \
      --env-file .env \
      --volume "$volume:/data" \
      --publish 127.0.0.1:8787:8787 \
      "$image" >/dev/null
    echo "Started $container. Follow the logs with: scripts/docker-dev.sh logs"
    ;;
  logs)
    docker logs --follow "$container"
    ;;
  down)
    down
    ;;
  reset)
    down
    docker volume rm "$volume" >/dev/null 2>&1 || true
    ;;
  *)
    sed -n '5,11p' "$0" >&2
    exit 2
    ;;
esac
