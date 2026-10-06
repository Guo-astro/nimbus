#!/bin/sh
set -e
pnpm build
pnpm exec wrangler deploy
