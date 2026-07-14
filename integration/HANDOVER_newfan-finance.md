# RAG広告配信システム × NewFan-Finance 繋ぎ込み 引継ぎ資料

- **対象**: NewFan-Finance(finance.newfan.co.jp)開発チーム / 広告システム開発チーム
- **作成日**: 2026-07-14
- **前提文書**: NF-RAGAD-BD-001(基本設計)/ DD-001(詳細設計)/ SD-001(画面詳細設計)
- **広告システム側リポジトリ**: `rag_ads`(このリポジトリ)。dev環境に全4スタックデプロイ済み・稼働中。
- **本資料の位置づけ**: 実際のNewFan-Financeコードベース(zip提供分)を精査した結果に基づく、
  媒体側改修の具体的手順と、両チームで合意が必要な意思決定事項の整理。

---

## 0. エグゼクティブサマリ

広告システム(rag_ads)側は、広告入稿→審査→承認→配信基盤→計測→日次バッチ→管理コンソールまで
**dev実AWSで稼働・検証済み**。媒体側(NewFan-Finance)は、回答ページに広告ブロックを表示し、
回答生成時に広告を確定する連携が必要。**フラグOFFのまま先行導入**し、段階公開する(DD-001 13.2)。

**実コード精査で判明した設計と実装の重要な乖離が2点あり、着手前に方針決定が必要**(→ 3章):
1. **埋め込みモデルの不一致**: 媒体は Gemini `gemini-embedding-001`(3072次元)、広告システムは
   Bedrock Titan(1024次元)。同一意味空間での広告検索(設計の前提)には整合が必要。
2. **回答生成の実体**: 設計はPython回答生成Lambdaを想定していたが、実体は **Next.js/LangChain**
   (`src/app/api/chat/route.ts`)。広告パイプラインの実行場所を決める必要がある。

---

## 1. NewFan-Finance コードベースの実態(精査結果)

| 項目 | 実態 |
|---|---|
| 基盤 | **Perplexica フォーク**(perplexica-frontend v1.11)。Next.js App Router + TypeScript |
| 回答生成 | `src/app/api/chat/route.ts`。LangChain でストリーミング(emitterイベント: response / sources / messageEnd)。**独立したPython Lambdaではない** |
| 回答ページ | `/c/[chatId]`。`ChatProvider(id=chatId)` → `ChatWindow` → **`MessageBox.tsx`** が Sources / Answer / Related を描画 |
| 記事データ | DynamoDB `prna-articles`(PK=article_id=url_hash)。取り込みは `lambda/prna-article-ingestor` |
| 記事ベクトル | **S3 Vectors `newfan-finance-vectors` / index `prna-articles`**。**Gemini埋め込み 3072次元・cosine**。検索は `src/lib/aws/s3-vectors-search.ts` |
| 埋め込み | **Gemini `gemini-embedding-001`**(Matryoshka: 3072/1536/768)。`EMBEDDING_PROVIDER` env で切替可(bedrock は未実装) |
| 既存広告コンポーネント | **`src/components/RagAds.tsx` が存在するがダミースタブ**(展示会ブース等のハードコード・どこからも未使用) |
| 設定 | `config.toml`(TOML)+ 環境変数。AWS SDK は既に導入済み(dynamodb / s3vectors / lib-dynamodb) |

---

## 2. 必要な媒体側改修(3点。BD-001 3.4節)

本キット `integration/newfan-finance/` に**ドロップイン可能な参照実装**を用意した。

### 改修1: 回答ページへの広告ブロック表示(FE-01)

- **既存の `src/components/RagAds.tsx`(ダミースタブ)を、本キットの `RagAds.tsx` で置換**。
  Perplexica の Tailwind トークン(light-/dark-)に合わせ済み。広告取得API をフェッチし、
  Related 直上に「スポンサー」見出し+最大3カード(広告ラベル・リード文・画像・CTA)を表示。
  高さ予約(CLS対策)・3秒タイムアウト・0件collapse・全文エスケープ・計測URL経由リンクを実装済み。
- **`src/components/MessageBox.tsx` の Related 直前に `<RagAds pageId={...} />` を挿入**
  (手順: `MessageBox.integration.md`)。回答本文・Sources・Related は改変しない。
- **広告取得プロキシ API**: `src/app/api/ads/[pageId]/route.ts` を新設(本キット `api-ads-route.ts`)。
  広告システムの `GET /v1/pages/{pageId}/ads` を同一オリジンでプロキシ(CORS回避・no-store維持・
  失敗時フェイルセーフ空配列)。

### 改修2: 回答生成時の広告確定(広告パイプライン G-1〜G-10)

回答生成時に広告を確定・課金し Placement を保存する(DD-001 3.2節)。**決定B=サービス方式で確定**。
**これを呼ばないと page-ads は常に空で広告は出ない(配信の起点)**。
- **サービス方式(決定B)**: 媒体の chat route から広告システムの生成エンドポイント
  `POST /v1/pages/{pageId}/generate-ads` を呼ぶ。媒体は `{pageId, question, articleContentIds,
  questionVector?}` を渡す。**参照実装: 本キット `chat-route-generate-ads.ts`**(fire-and-forget・
  タイムアウト・冪等・フェイルセーフ)。pageId は RagAds と同一の `assistantMessage.messageId`。
- **表示計測はここでは発生しない**。生成APIは「配信確定(citations=課金)」のみを行い、
  **表示(impressions)は RagAds→page-ads フェッチ時にのみ計上**する(実表示計上。二重計上を防ぐ)。

### 改修3: 回答生成レスポンスへの ads[] 付加(任意・非推奨)

初回生成時に `ads[]` を付加し `<RagAds initialAds={ads} />` とすれば初回フェッチを省略できるが、
**表示計測が page-ads フェッチ時のみになった現仕様では、initialAds で初回フェッチを省くとその表示が
impression に計上されない**。初回もフェッチする改修1の方式(`<RagAds pageId={...} />`)を推奨する。
どうしても initialAds を使う場合は、表示時に別途 page-ads を呼ぶか表示ビーコンを追加すること。

---

## 3. 着手前に両チームで決定が必要な事項 ★重要

### 決定A: 埋め込みモデルの整合(最重要)

設計(BD-001 3.3)は「記事と広告で同一埋め込みモデルを用い、質問1回の埋め込みを共用」を前提とするが、
現状は媒体=Gemini 3072次元、広告=Bedrock Titan 1024次元で**空間が非互換**。広告候補検索は
質問ベクトルと広告ベクトルの類似度で行うため、両者が同一空間でなければ機能しない。

| 選択肢 | 内容 | トレードオフ |
|---|---|---|
| **A-1(推奨)** | 広告システムを **Gemini 3072次元に揃える**。広告ベクトルをGeminiで再生成し、S3 Vectors広告インデックスを3072次元で作り直す。媒体の質問埋め込みを広告検索に共用可能 | 設計の「単一埋め込み」を満たす。Geminiキー・インデックス再構築・全広告再エンベドが必要 |
| A-2 | 広告システムは Titan 1024 のまま独立。広告パイプライン側で質問を**別途Titanで再埋め込み**して広告検索 | 広告システムが自立。質問あたり埋め込みが2回・媒体の埋め込みを再利用できない |

- **広告システム側は本セッションで A-1 に即応できるよう対応済み**: `shared/embeddings.mjs` を
  プロバイダ切替(bedrock / gemini)に対応させた。CDKで `-c embedProvider=gemini -c embedDimension=3072
  -c geminiApiKey=...` を渡し、S3 Vectorsインデックスを3072次元で作り直せば Gemini空間へ移行できる。
  **未決定のためdevは bedrock/1024 のまま**(独立稼働)。
- **決定事項**: A-1 / A-2 のどちらを採るか。A-1 の場合、Geminiキーの共有と広告インデックス再構築の
  実施時期。

### 決定B: 広告パイプラインの実行場所(改修2)

- **サービス方式(推奨)**: 疎結合。広告ロジックは広告システムに集約。媒体は1コール追加。
  → 広告システムに「広告生成」エンドポイント(`POST /v1/pages/{pageId}/generate-ads` 等)の
  新設が必要(**本セッションでは未実装**。決定A・認証境界の確定後に実装するのが適切)。
- **インライン方式**: 低レイテンシだが結合度が高く、広告ロジックの二重管理リスク。
- **決定事項**: 方式の選択。サービス方式なら、媒体→広告システム間の認証(サービス間APIキー等)。

### 決定C: pageId の粒度

広告は回答単位で課金されるため、`pageId` は回答ごとに一意な `assistantMessage.messageId` を推奨
(chatId は会話単位で粗い)。広告システムの pageId 検証(現状 `[0-9a-f]{8,64}`)を messageId の
形式に合わせて緩めるか、媒体側で正規化するか。**本キットのプロキシは英数許容で実装済み**。

### 決定D: 計測URL `/r/{pageId}/{slot}` のドメイン配置

クリック計測はユーザーを広告主サイトへ302する。`finance.newfan.co.jp/r/...` を広告システムの
click Lambda へルーティングする(CloudFrontビヘイビア追加 or API Gatewayカスタムドメイン。6.1節)。
本キットのプロキシ方式なら `/r/` も同様に媒体ドメイン配下へ向ける設定が必要。

---

## 4. API 契約(広告システム提供・確定済み)

### GET /v1/pages/{pageId}/ads(配信・公開)
広告取得(RagAdsが表示時にフェッチ)。応答は常に200(Placementなし・全無効・形式不正も空配列)。`Cache-Control: no-store`。
**このフェッチ時に表示(impressions)を計上する(=実表示計上の単一地点)**。有効性はスナップショットではなく
現在のRagAds.statusと期間で再判定(期限切れ広告は自動的に消える)。
```json
{ "pageId": "…", "ads": [
  { "slot": 1, "adId": "01J…", "label": "広告",
    "lead": "変動金利の見直しを検討中の方に、無料の返済シミュレーション相談があります。",
    "title": "住宅ローン借り換え無料診断",
    "imageUrl": "https://cdn.example.com/loan.jpg",   // null可
    "clickUrl": "/r/{pageId}/1" } ] }
```

### GET /r/{pageId}/{slot}(クリック計測・公開)
clicks加算 → 広告主 landingUrl(Placementスナップショット)へ302。不正時はサイトトップへ302
(オープンリダイレクト防止)。

### POST /v1/pages/{pageId}/generate-ads(広告生成・サービス方式)★実装済み
媒体の回答生成(`src/app/api/chat/route.ts`)から回答確定時に呼ぶ。広告パイプライン G-1〜G-10 を実行し、
Placement を確定・課金して `ads[]` を返す(冪等: 同一pageIdの再呼び出しは再課金しない)。
- **認証**: `X-Api-Key: <サービスキー>`(SSM `/rag_ads/{env}/service_api_key`。運用でローテーション)。
- **リクエスト**:
```json
{ "question": "日銀の追加利上げは住宅ローン金利にどう影響しますか？",
  "articleContentIds": ["FIN-001", "FIN-002"],   // 回答に使用した記事ID(紐づけ加点・任意)
  "questionVector": [ /* 3072次元 */ ] }          // 媒体のGemini質問埋め込み(A-1後・任意)
```
- **questionVector**: 決定A-1(Gemini統一)後は媒体の質問埋め込みをそのまま渡すことで、広告システムでの
  再埋め込みを省ける(設計の「質問1回の埋め込み」。BD-001 3.3節)。**渡すベクトルの次元は広告インデックスと
  一致必須**(A-1後=3072)。未指定時は広告システムが自前で埋め込む。
- **応答**: `{ "pageId": "…", "ads": [ …6.2.1と同形… ] }`。広告なし・失敗時は空配列(回答生成を妨げない)。
- **課金と計測**: この生成呼び出しは Placement確定+課金(citations)のみを行い、**表示(impressions)は計上しない**。
  表示は page-ads フェッチ時に計上(実表示計上・二重計上防止)。応答の`ads[]`は使わなくてよい(RagAdsがpage-adsで表示)。
- **pageId**: `assistantMessage.messageId`(英数・-・_、8〜64字)を許容(決定C)。RagAdsに渡す値と必ず同一。

### 管理系(Cognito JWT)
広告CRUD・審査・紐づけ・レポート・パラメータは管理コンソール(S-01〜S-05)から利用。媒体側改修とは独立。

---

## 5. デプロイ・段階公開(DD-001 13.2)

| 段階 | 対象 | 操作 | 次段階への判定 |
|---|---|---|---|
| 0 | 上記改修をフラグOFFで先行導入 | `PUT /v1/params {"enabled": false}` のまま媒体をリリース | スモーク通過・既存機能無影響(レイテンシ・エラー率) |
| 1 | 社内アカウントのみON | フラグON+対象限定 | 表示崩れなし・アラームなし3日間 |
| 2 | 実トラフィック10% | pageIdハッシュで判定 | AdFillRate・レイテンシ・エラー率が目標内で7日間 |
| 3 | 100% | — | 検証運用へ移行(BD-001 11章) |

- **ロールバック一次手段はフラグOFF**(即時・デプロイ不要)。`enabled=false` の間は配信API が空配列を
  返し、RagAds は自動的に非表示になる(媒体側の変更なしで縮退)。
- フラグOFF時は広告パイプラインも全スキップ(課金・Placement保存なし)。

---

## 6. 広告システム側の現状(dev実AWS・稼働中)

| 機能 | 状態 |
|---|---|
| 管理コンソール S-01〜S-05 | ✅ CloudFront配信・Cognito認証・Bedrockスクリーニング実動作(Chrome検証済み) |
| 広告CRUD・審査・ベクトル同期・紐づけ・レポート | ✅ admin-api 全実装(実DynamoDB/S3 Vectors/Bedrock) |
| 配信API(page-ads / click) | ✅ 実装・E2E検証済み |
| 日次バッチ(集計+状態自動遷移) | ✅ 期限切れ/配信開始の自動遷移+ベクトル同期・冪等 |
| 埋め込みプロバイダ切替(bedrock/gemini) | ✅ 実装済み。**dev は決定A-1(Gemini統一)へ移行完了**(gemini-embedding-001/3072、媒体 `embedding-client.ts` と同一エンドポイント・taskType未指定で同一空間) |
| **広告生成エンドポイント(改修2サービス方式)** | ✅ **実装・dev E2E検証済み**(`POST /v1/pages/{pageId}/generate-ads`。サービスキー認証)。関連質問→広告1件(Haiku実リード文)/無関連質問→空(θ_rel除外)/同一pageId再呼び出し→同一広告・再課金なし、を実AWSで確認 |
| θ_rel較正 | **Gemini向けに0.70へ再較正済み**(dev実測: 関連質問0.74〜0.90 / 無関連0.56〜0.65)。Titan時は0.25 |
| dev 設定状態 | **Gemini/3072・θ_rel=0.70・段階0(enabled=false)** で待機。サンプル配信広告2件はGeminiで再エンベド済み・3072インデックス投入済み。`enabled=true` で即スモーク可能 |

> **運用注意(日本語データの確認)**: Windowsの `aws` CLI は `--output text/json` の標準出力を端末コードページ(CP932)で書き出すため、SSMパラメータやDynamoDB項目の**日本語が文字化けして見える**ことがある(例: `lead.fallback_text` が `������Ɋ֘A…`)。これは**表示上の錯覚で、保存値はUTF-8で正常**。実値の確認・書き込みは AWS SDK 経由(または PowerShell で `[Console]::OutputEncoding=[Text.Encoding]::UTF8`)で行うこと。日本語を含む値を `aws ssm put-parameter --value 'あ…'` のように**コマンド引数**で渡すと CP932 で化けて保存されうるため、日本語の書き込みは SDK か `--cli-input-json file://<UTF-8ファイル>` を用いる。

## 8. Gemini統一(決定A-1)移行 Runbook 【dev実行済み 2026-07-14】

広告システムを媒体のGemini 3072次元空間へ揃える手順。**dev環境では実行・E2E検証まで完了**。
prod適用時も同手順(prod用のGeminiキー・バケットで実施)。

- **埋め込み互換性**(検証済み): 広告側 `embeddings.mjs` の `embedGemini` は媒体
  `lambda/prna-vectors-ingestor/embedding-client.ts` と同一(`gemini-embedding-001` /
  `outputDimensionality=3072` / **taskType未指定=同一デフォルト** / 正規化なし・ノルム≈1.0)。
  同一の意味空間になるため、媒体の質問埋め込みで広告インデックスを検索できる。
- **フットガン対策**(実装済み): `-c embedProvider=gemini` を指定すれば **次元は自動で3072**
  (`bin/rag-ads.js`)、**θ_rel既定も自動で0.70**(`api-stack.js`)になる。個別指定は不要かつ誤設定を防ぐ。

手順:
1. **キー共有**: 媒体のGemini APIキーをデプロイに渡す。`-c geminiApiKey=<KEY>` か環境変数
   `RAG_ADS_GEMINI_API_KEY`(後者はシェル履歴に残らず推奨)。※ dev の Lambda 環境変数へ平文で入る。
   **prodでは SecureString / Secrets Manager 化を推奨**。
2. **広告インデックス再構築**: 既存インデックスを削除し3072で作り直す(冪等)。
   ```
   aws s3vectors delete-index  --vector-bucket-name rag-ads-vectors-<env> --index-name rag-ads-index-<env>
   bash infra/scripts/create-vector-index.sh <env> rag-ads-vectors-<env> ap-northeast-1 3072
   ```
3. **プロバイダ切替デプロイ**(次元・θ_relは自動連動):
   ```
   cd infra && bash scripts/build-layer.sh
   export RAG_ADS_GEMINI_API_KEY=<KEY>
   npx cdk deploy RAG-Ads-Api-Stack-<env>   --exclusively -c env=<env> -c embedProvider=gemini -c serviceApiKey=<現行キー>
   npx cdk deploy RAG-Ads-Batch-Stack-<env> --exclusively -c env=<env> -c embedProvider=gemini
   ```
   ※ Api→Batch はレイヤー独立化済みのため個別 `--exclusively` で順に。serviceApiKey未指定だと上書きされるので現行値を渡す。
4. **全広告の再エンベド**: 配信中広告のベクトルをGeminiで作り直す。dev では
   `infra/lambda/shared-src/ragshared`(`adEmbeddingText`→`embed`→`putVector`)を用いた一括スクリプトで実施。
   本番の多数広告向けには**専用の一括再エンベドバッチの実装を推奨**(ロジックは admin-api の syncVector と同一)。
   代替として管理API経由で各広告を paused→再出稿→承認しても再エンベドされる。
5. **θ_rel 再較正**: **dev実測で 0.70 を採用済み**(関連質問0.74〜0.90 / 無関連0.56〜0.65。Titanの0.25とは分布が異なる)。
   `-c embedProvider=gemini` の既定で0.70になるが、広告が増えたら数十件の代表質問で再測定し
   `PUT /v1/params {"theta_rel": <新値>}` で調整する。
6. **媒体側**: 回答生成の Gemini 質問埋め込みを generate-ads の `questionVector` に渡す(再埋め込み省略。**dev検証済み**)。

- 環境識別子: AWSアカウント 654654601240 / ap-northeast-1。配信API・管理コンソールURL・Cognito等の
  接続情報は `infra/README.md` 参照。

---

## 7. 次アクション

1. **決定A〜D 確定済み**(A-1:Gemini統一 / B:サービス方式 / C:pageId=messageId / D:計測URLは広告システム側)。
2. **A-1 は dev で実行・E2E検証まで完了**(gemini/3072・θ_rel=0.70・広告再エンベド・questionVector連携)。
   prod では prod用キー/バケットで §8 の手順を再実行するのみ。残タスクは「本番多数広告向けの一括再エンベドバッチ実装(任意)」と「Geminiキーの SecureString 化(prod)」。
3. B:サービス方式(採用済み・決定B): 広告生成エンドポイント `POST /v1/pages/{pageId}/generate-ads` は
   **実装・dev E2E検証済み**(パイプライン G-1〜G-10。ローカル `server/pipeline.js`・テスト48件が仕様の正)。
   媒体側は回答確定時にサービスキー付きで本エンドポイントを呼ぶだけでよい。
4. 媒体側: 本キット3点(RagAds.tsx置換・MessageBox挿入・プロキシルート)を**フラグOFF**で導入。
5. スモーク → 段階1(社内ON)→ 段階2(10%)→ 段階3(100%)。
