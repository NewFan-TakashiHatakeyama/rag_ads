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

## 現段階の実装状況

- **配信系Lambda(page-ads / click)**: DynamoDB SDK版で完全実装。ローカルPoC(`server/pipeline.js`)で
  検証済みのロジック(有効性判定・表示/クリック計測・オープンリダイレクト防止)を移植済み。
- **日次集計Lambda(daily-agg)**: 確定値再計算(GSI1走査・冪等・impressions/clicks保持)を実装済み。
  期限切れ/配信開始の自動遷移はフェーズ1.5で追加(一次防御はベクトルメタデータフィルタのため未実装でも配信誤りなし)。
- **管理API(admin-api)**: `/v1/params`(表6の参照・検証付き更新=段階公開のフラグ操作)を実装済み。
  広告CRUD・審査・紐づけ・レポートは501の雛形(BD-001 W1-W2「API雛形」)。フェーズ1.5で
  `server/adminApi.js`(テスト48件で検証済み)から移植する。

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
