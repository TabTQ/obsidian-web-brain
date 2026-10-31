#!/usr/bin/env bash
# Build a self-contained release tarball: single-file server bundle + static web UI.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build -w web
rm -rf release && mkdir -p release/brain/server release/brain/web
npx esbuild server/src/main.ts --bundle --platform=node --target=node22 --format=esm \
  --outfile=release/brain/server/main.mjs --legal-comments=none \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);"
cp -r web/dist/. release/brain/web/
cp deploy/brain.service deploy/install.sh release/brain/
VERSION=$(node -p "require('./package.json').version")-$(git rev-parse --short HEAD)
echo "$VERSION" > release/brain/VERSION
tar -C release -czf "release/brain-$VERSION.tar.gz" brain
echo "release/brain-$VERSION.tar.gz"
