#!/usr/bin/env bash
# S3 Vectors 広告インデックスの作成(DD-001 5.4節/表16)。
# S3 VectorsはCloudFormation管理外のためCLIでセットアップする。冪等(存在時はスキップ)。
#
# 使い方: ./create-vector-index.sh <env> [vector-bucket-name] [region] [dimension]
#   dimensionは埋め込みモデルの出力次元に一致させる(既存記事インデックスと同一。5.4節)。
#   amazon.titan-embed-text-v2:0 の既定は1024。
set -euo pipefail

ENV="${1:?env(dev|prod)を指定してください}"
BUCKET="${2:-rag-ads-vectors-${ENV}}"
REGION="${3:-ap-northeast-1}"
DIMENSION="${4:-1024}"
INDEX="rag-ads-index-${ENV}"   # 表16(14.3例外: 小文字ハイフン)

echo "== ベクトルバケット: ${BUCKET} (${REGION})"
if aws s3vectors get-vector-bucket --vector-bucket-name "${BUCKET}" --region "${REGION}" >/dev/null 2>&1; then
  echo "   既存バケットを使用します"
else
  aws s3vectors create-vector-bucket --vector-bucket-name "${BUCKET}" --region "${REGION}"
  echo "   作成しました"
fi

echo "== 広告インデックス: ${INDEX} (dimension=${DIMENSION}, cosine)"
if aws s3vectors get-index --vector-bucket-name "${BUCKET}" --index-name "${INDEX}" --region "${REGION}" >/dev/null 2>&1; then
  echo "   既存インデックスを使用します"
else
  # メタデータ(adId/category/status/campaignStart/campaignEnd/unitPrice/advertiserId)は
  # すべてフィルタ可能属性(DD-001 5.4節)= 非フィルタ対象キーの指定なし
  aws s3vectors create-index \
    --vector-bucket-name "${BUCKET}" \
    --index-name "${INDEX}" \
    --data-type float32 \
    --dimension "${DIMENSION}" \
    --distance-metric cosine \
    --region "${REGION}"
  echo "   作成しました"
fi

echo "== 完了。cdk.json の vectorBucketName に '${BUCKET}' を設定してください"
