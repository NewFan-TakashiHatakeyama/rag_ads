#!/usr/bin/env bash
# 共有Lambdaレイヤーのビルド。
# nodejs/ に SDK依存を npm install した後、shared-src/ragshared を node_modules/ragshared へコピーする。
# (npm install は宣言外パッケージをプルーニングするため、ragsharedは install後にコピーする)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODEJS="$HERE/lambda/layers/shared/nodejs"
SRC="$HERE/lambda/shared-src/ragshared"

echo "== SDK依存を導入(nodejs/)"
( cd "$NODEJS" && npm install --omit=dev --no-audit --no-fund )

echo "== ragshared を node_modules へ配置"
rm -rf "$NODEJS/node_modules/ragshared"
mkdir -p "$NODEJS/node_modules/ragshared"
cp "$SRC"/*.mjs "$SRC/package.json" "$NODEJS/node_modules/ragshared/"

echo "== 構文検証"
for f in "$NODEJS/node_modules/ragshared"/*.mjs; do node --check "$f"; done
echo "== 完了: $(ls "$NODEJS/node_modules/ragshared" | tr '\n' ' ')"
