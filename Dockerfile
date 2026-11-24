# Copyright 2026 Kong Weirui
# SPDX-License-Identifier: MIT

FROM node:24-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-alpine
ARG VERSION=dev

LABEL org.opencontainers.image.title="Supa Visa" \
      org.opencontainers.image.description="Issue time-limited Cloudflare IP allowlist entries after a passkey check." \
      org.opencontainers.image.source="https://github.com/supacode-org/supa-visa" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

# Supa Visa never installs anything at runtime; without a package manager there
# is less in the image to misuse.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir /data \
    && chown node:node /data

WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
RUN ln -s /app/src/main.ts /usr/local/bin/supa-visa

ENV NODE_ENV=production \
    DATA_FILE=/data/visa.json \
    LISTEN=0.0.0.0:8787

USER node
VOLUME /data
EXPOSE 8787

# The image has no curl; Node's fetch checks the port LISTEN names.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.LISTEN || '').split(':').pop() + '/healthz').then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["supa-visa"]
