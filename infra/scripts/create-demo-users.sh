#!/usr/bin/env bash
# 検証用Cognitoユーザーの作成(BD-001 11.2: 社内利用の検証体制)。冪等。
# 使い方: ./create-demo-users.sh <user-pool-id> <email> <password> <group: advertiser|admin> [region]
set -euo pipefail

POOL="${1:?user-pool-idを指定してください}"
EMAIL="${2:?emailを指定してください}"
PASSWORD="${3:?passwordを指定してください}"
GROUP="${4:?group(advertiser|admin)を指定してください}"
REGION="${5:-ap-northeast-1}"

if ! aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$EMAIL" --region "$REGION" >/dev/null 2>&1; then
  aws cognito-idp admin-create-user \
    --user-pool-id "$POOL" --username "$EMAIL" \
    --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
    --message-action SUPPRESS --region "$REGION" >/dev/null
  echo "ユーザー作成: $EMAIL"
fi
aws cognito-idp admin-set-user-password \
  --user-pool-id "$POOL" --username "$EMAIL" \
  --password "$PASSWORD" --permanent --region "$REGION"
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$POOL" --username "$EMAIL" --group-name "$GROUP" --region "$REGION"
echo "設定完了: $EMAIL (グループ: $GROUP)"
