# RAG広告配信システム IaC(フェーズ1)

NF-RAGAD-DD-001 13章/14章準拠のAWS CDKプロジェクト。4スタックで広告システムを構築する。
**媒体側(finance.newfan.co.jp)の変更ゼロで、広告入稿→審査→管理→配信基盤が本番で動き始める段階。**

## スタック構成(DD-001 13.1)

| スタック | 主なリソース | 物理名(dev) |
|---|---|---|
| RAG-Ads-Data-Stack | DynamoDB 3テーブル(GSI・TTL)、ベクトル同期DLQ | `rag_ads_master_dev` 他 |
| RAG-Ads-Api-Stack | Lambda(page-ads/click/admin-api)、HTTP API、Cognito、SSMパラメータ(表6) | `rag-ads_page-ads-dev` 他 |
| RAG-Ads-Batch-Stack | 日次集計Lambda、DLQ再処理、EventBridge(04:00 JST)、SNS、アラーム、ダッシュボード | `rag-ads_daily-agg-dev` 他 |
| RAG-Ads-Front-Stack | 管理コンソールSPA(S3+CloudFront) | `rag-ads-admin-dev-{account}` |

命名はすべて `lib/naming.js`(表15・表16)経由。デプロイ順序は依存関係で Data→Api→Batch→Front に強制。

## デプロイ手順

```bash
cd infra
npm install

# 1. S3 Vectors 広告インデックスを作成(CloudFormation管理外。5.4節)
#    dimensionは既存記事インデックス=埋め込みモデルの出力次元に合わせる
bash scripts/create-vector-index.sh dev rag-ads-vectors-dev ap-northeast-1 1024

# 2. cdk.json の vectorBucketName / siteTopUrl を環境に合わせて設定

# 3. 4スタックをデプロイ(フラグOFF=段階0。13.2節)
npm run deploy:dev      # = cdk deploy --all -c env=dev

# 4. 検証用Cognitoユーザーを作成(BD-001 11.2)
bash scripts/create-demo-users.sh <UserPoolId> admin@newfan.co.jp '<pw>' admin
bash scripts/create-demo-users.sh <UserPoolId> advertiser01@example.co.jp '<pw>' advertiser
```

## 実接続(Bedrock / S3 Vectors)

共有Lambdaレイヤー `ragshared`(`infra/lambda/shared-src/ragshared/`)で実サービスに接続する。
`scripts/build-layer.sh` でSDK依存を導入しレイヤーへ配置する(**cdk deployの前に実行が必要**)。

| 用途 | サービス・モデル | 備考 |
|---|---|---|
| 埋め込み | Bedrock Titan Embed v2(1024次元・正規化) | 記事・広告・質問で共用。S3 Vectorsインデックスと次元一致 |
| 質問分類/リード文/スクリーニング | Bedrock Claude Haiku 4.5(`jp.anthropic.claude-haiku-4-5-20251001-v1:0`) | **オンデマンド不可・推論プロファイル必須**。SSM `lead.model_id` |
| ベクトル検索 | S3 Vectors `rag-ads-index-dev` | フィルタ status=delivering AND 期間内(期間はYYYYMMDD数値メタデータ) |

## 現段階の実装状況(フェーズ1.5完了)

- **配信系Lambda(page-ads / click)**: 完全実装。有効性判定・表示/クリック計測・オープンリダイレクト防止。
- **日次集計Lambda(daily-agg)**: 確定値再計算(GSI1走査・冪等・impressions/clicks保持)。
  期限切れ/配信開始の自動遷移は媒体側パイプライン移植とあわせて追加(一次防御はベクトルフィルタ)。
- **管理API(admin-api)**: **全エンドポイント実装済み**(`server/adminApi.js`を実DynamoDB/S3 Vectors/Bedrockへ移植)。
  広告CRUD・表10ステータス遷移・ベクトル同期(承認Put/停止Delete)・スクリーニング・紐づけ・レポート・
  コンテンツ詳細・パラメータ。

## 記事テーブル接続(S-03/S-03-1)

コンテンツ紐づけ(F-05)は記事テーブルを参照する。本番は媒体側NewFan-Finance既存記事テーブルを
**読み取り専用**で参照する(6.3.3節・admin-apiには読取権限のみ付与。11.4節)。

dev環境には媒体テーブルが無いため、DataStackが検証用スタンドイン `rag_ads_contents_{env}`(dev/staging限定・
prodでは作らない)を作成する。シードは `node infra/scripts/seed-contents.mjs dev`(レイヤーのnode_modulesがある
`infra/lambda/layers/shared/nodejs/`から実行)。

- **有効化される機能**: link-candidates(関連度順・上位10件)、S-03紐づけ(実行/解除・優先度・relevanceScore記録)、
  S-03-1コンテンツ詳細(記事メタ・本文プレビュー・関連度・一致キーワード・競合広告数=GSI2逆引き)。
- **仕様どおり省略**: 引用回数/日・質問タイプ内訳は媒体側の応答ログ未接続のため省略(6.3.3節「取得可能な範囲。
  不可時はフィールド省略」)。媒体側応答ログ接続で有効化。
- **prod移行**: prodではこのテーブルを作らず、媒体テーブル名/ARNをApiStackへ渡し、admin-apiの
  `RAG_Ads_TABLE_CONTENTS` に設定する(属性名は既存スキーマへ読み替え。6.3.3節)。

## θ_rel 較正(重要)

**ローカルモック用の θ_rel=0.50 は実Titan埋め込みには不適**。dev実測(2026-07-14)では
住宅ローン広告に対し関連質問が類似度0.32〜0.42・無関連が0.12未満に分布したため、初期値を
**0.25** に較正済み(CDK default + dev SSM)。検証運用で継続チューニング(BD-001 11.2)。

**運用上の留意**: SSMパラメータはCDK管理のため、`cdk deploy`が実行時チューニング値をCDK既定値へ
上書きする。検証運用で頻繁にチューニングする段階に入ったら、チューニング対象パラメータ(theta_rel・
weights.*・lead.*)はCDK管理から外す(初回のみ作成し以後はAPI経由で更新)ことを推奨。

## スモークテスト結果(dev・実AWS)

デプロイ後に実施し全項目パス:
- 広告取得API: Placementなし/形式不正で200空配列、有効広告の返却+表示計測(DynamoDB加算を実データ確認)
- クリック計測: 正常302(スナップショットlandingUrl)/不正時サイトトップへ302
- 認可: 管理系は無認証401、admin以外403、パラメータ不正値はAPI-4001、未移植は501
- 日次バッチ: citations/cost/citationChars確定・impressions/clicks保持・finalized=true(285ms)
- 管理コンソールSPA: CloudFront経由200

## ロールバック・撤去

- 段階公開のロールバック一次手段はフラグOFF(`PUT /v1/params {"enabled": false}`。デプロイ不要)。
- dev環境の撤去: `npx cdk destroy --all -c env=dev`(prodはPlacement/DailyStats/master/SPAバケットがRETAIN)。
  S3 Vectorsインデックスは手動削除(`aws s3vectors delete-index`)。
