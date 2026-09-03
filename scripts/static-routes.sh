#!/usr/bin/env bash
set -euo pipefail

cp dist/index.html dist/404.html
for route in login forgot-password reset-password auth/confirm account; do
  mkdir -p "dist/${route}"
  cp dist/index.html "dist/${route}/index.html"
done
