# RAG広告配信システム PoC (rag_ads)

NF-RAGAD-BD-001(基本設計書)・NF-RAGAD-DD-001(詳細設計書)・NF-RAGAD-SD-001(画面詳細設計書)に基づく、
**引用課金モデル**のRAG広告配信システムのローカル実行版PoCです。

## 起動

```bash
npm start          # http://localhost:8787
npm test           # 自動テスト(DD-001 12.3 IT-01〜IT-21相当・41件)
npm run seed       # 初期データ再投入(データリセット)
npm run batch:daily-agg  # 日次集計バッチ(DD-001 9.1)手動実行
```

| URL | 画面 |
|---|---|
| `http://localhost:8787/` | NewFan-Financeデモ(質問→回答ページ生成) |
| `http://localhost:8787/c/{pageId}` | 回答ページ+FE-01広告ブロック(AdSlotBlock) |
| `http://localhost:8787/admin` | 広告管理コンソール(S-01〜S-05) |

**デモアカウント**: 広告主 `advertiser01@example.co.jp` / `demo1234`(02, 03も同様)、
管理者 `admin@newfan.co.jp` / `admin1234`

## 本番設計(AWS)との対応

設計書はAWSサーバーレス構成(DynamoDB / S3 Vectors / Bedrock / Cognito / Lambda)を前提としています。
本PoCは**機能仕様・API仕様・画面仕様・データモデルを忠実に実装**し、AWS依存部分をアダプタ層で代替しています。

| 本番設計 | ローカルPoC実装 | 対応ファイル |
|---|---|---|
| DynamoDB 3テーブル(キー設計・条件式・TransactWrite) | 同一キー設計のJSON永続ストア(条件式セマンティクス実装) | `server/store.js` |
| S3 Vectors 広告インデックス(メタデータフィルタ) | インメモリベクトルインデックス(同一のフィルタ仕様) | `server/store.js` |
| Bedrock埋め込みモデル(記事・広告・質問で共用) | 文字bigram TFベクトル+コサイン類似度(√スケーリングでθ_rel=0.5に較正) | `server/vector.js` |
| Bedrock Haiku級(質問分類/リード文生成/スクリーニング) | 同一の入出力契約(JSON・検証・フォールバック)を持つルールベース実装 | `server/llm.js` |
| Cognito(advertiser/adminグループ) | 同一の認可モデルを持つセッショントークン認証 | `server/auth.js` |
| SSM Parameter Store(`/rag_ads/{env}/`) | `data/params.json`(5分キャッシュ・表6の全パラメータ) | `server/config.js` |
| Lambda群+API Gateway | 単一Nodeプロセス(依存パッケージなし) | `server/server.js` |
| EventBridge日次集計(04:00 JST) | 手動実行(`npm run batch:daily-agg` / `POST /v1/batch/daily-agg`) | `server/batch.js` |

## 実装済み機能

- **広告パイプライン(DD-001 3.2 G-1〜G-10)**: 質問分類→候補検索(status/期間フィルタ)→
  除外(θ_rel・ターゲット・予算)→スコアリング`w_rel×sim + w_bid×bid + w_link×link`→
  3枠割当(同一広告主1枠)→予算条件付き加算(超過は次点繰上げ)→リード文一括生成(検証NG/失敗は
  フォールバック定型文)→Placement冪等保存(失敗時は補償減算)→ads[]返却
- **管理API(DD-001 6章)**: 広告CRUD(submit=下書き/出稿)・表10のステータス遷移・紐づけ・
  レポート・コンテンツ詳細(6.3.3)・エラー形式(API-4001〜5001)
- **配信API**: `GET /v1/pages/{pageId}/ads`(有効性判定+表示計測)・`GET /r/{pageId}/{slot}`
  (クリック計測→スナップショットURLへ302。オープンリダイレクト防止)
- **画面(SD-001)**: S-01一覧 / S-02 3ステップウィザード / S-03紐づけ / S-03-1コンテンツ詳細 /
  S-04レポート(KPI+CSV) / S-05審査キュー / FE-01 AdSlotBlock(高さ予約・3秒タイムアウト・
  0件collapse・全文エスケープ・「広告」ラベル固定)
- **透明性・安全(F-13, 11章)**: 広告ラベル常時表示・NG辞書+インジェクション検査・
  リード文検証・XSS対策(サーバー入力検証+フロント全エスケープ)

## PoC簡易化(設計書との差分)

- 認証はCognitoの代わりに簡易セッション(認可モデルは表13どおり)
- レート制限・CloudWatchメトリクス/アラームは未実装(構造化ログはDD-001 10.1準拠で出力)
- `approved`ステータスはシードのバッジ表示デモ用(承認操作は6.3.2どおり即`delivering`)
- 下書き保存(submit=false)はタイトルのみ必須とし他項目は形式検証のみ(S-02の途中保存を許容)
- 配信中/承認済の広告をPUTすると`draft`(下書き保存時)または`reviewing`(出稿時)へ遷移し
  ベクトルを即時削除(BD-001 4.2.2「未審査の内容が配信されない」保証を優先)
