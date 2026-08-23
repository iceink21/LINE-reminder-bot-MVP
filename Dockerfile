# Debian/glibc base, NOT Alpine/musl: better-sqlite3 ships glibc prebuilds and
# its native addon segfaults when loaded under a mismatched libc (the Nixpacks
# nixpkgs-Node failure this Dockerfile exists to eliminate).

# Node 22, not 20: better-sqlite3@13 declares engines {"node": ">=22"}.
#
# --- deps: resolve node_modules, including better-sqlite3's native addon ---
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NODE_ENV=production

# better-sqlite3 ships a bundled prebuilds/linux-x64.node and has no install
# script, but it does ship a binding.gyp -- so npm runs the default
# `node-gyp rebuild` regardless. These tools satisfy that compile and stay in
# this stage only; the runtime image below never receives them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Copied first so the dependency layer caches independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime: same base image, so the addon runs on the libc it was built for ---
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src

# Documentation only. The app binds process.env.PORT (default 3000 in
# src/config.js); Railway injects PORT at runtime, so nothing is hardcoded.
EXPOSE 3000

CMD ["node", "src/index.js"]
