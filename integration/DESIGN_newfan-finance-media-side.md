# NewFan-Finance 媒体側 実装設計書(RAG広告 繋ぎ込み)

> 本書は **媒体 NewFan-Finance(Perplexica フォーク / Next.js・TypeScript)側の改修**の設計書。
> 広告システム(RAG広告配信システム)は dev 実AWSに構築・検証済みで、本書に沿って媒体側を実装すれば
> 広告の**配信・表示計測・クリック計測**が成立する。新しいセッションで本書を読み、実コードへ適用して実装する想定。
>
> 併読: `integration/HANDOVER_newfan-finance.md`(全体像・API契約) /
> ドロップイン参照実装: `integration/newfan-finance/`(RagAds.tsx・api-ads-route.ts・chat-route-generate-ads.ts)

---

## 0. 前提(確定事項)

| 項目 | 値 |
|---|---|
| 実行方式 | **サービス方式(決定B)**: 媒体が広告システムの生成/配信APIを呼ぶ。パイプラインは広告システム側 |
| 埋め込み | **Gemini gemini-embedding-001 / 3072次元(決定A-1)**。媒体の `embedding-client.ts` と同一空間(検証済み) |
| pageId | **`assistantMessage.messageId`(決定C)**。NewFan-Financeでは `crypto.randomBytes(7).toString('hex')`=14桁hex |
| 計測URL | **`/r/{pageId}/{slot}` を媒体ドメインから広告システムへ転送(決定D)** |
| 広告システム状態 | Gemini/3072・θ_rel=0.70・**段階0(enabled=false)** で待機中。`enabled=true` で即配信 |
| 広告API Base | dev: `https://r29apdxkdc.execute-api.ap-northeast-1.amazonaws.com`(本番は別途) |
| サービスキー | SSM `/rag_ads/dev/service_api_key`(媒体の環境変数 `RAG_ADS_SERVICE_API_KEY` に設定) |

**フェイルセーフ原則(必須)**: 広告処理の失敗・遅延は**回答本文の生成・表示を絶対に妨げない**。
すべての広告呼び出しは try/catch・タイムアウト・0件時collapse で縮退する。

---

## 1. アーキテクチャと3つのフロー

```
 ┌─────────────────────────── NewFan-Finance (媒体) ───────────────────────────┐
 │                                                                              │
 │  [chat route]  回答生成 ──(A)生成API呼び出し──▶ 広告システム POST /generate-ads │
 │  api/chat/route.ts        question, articleContentIds        (Placement確定+課金) │
 │                                                                              │
 │  [MessageBox]  回答表示 ──(B)表示フェッチ──▶ /api/ads/{pageId}(プロキシ)        │
 │   └ <RagAds pageId>           GET                └▶ 広告システム GET /v1/pages/{id}/ads │
 │                                                        (表示計測=impression) │
 │                                                                              │
 │  [RagAds カード] クリック ──(C)/r/{pageId}/{slot}──(rewrite)──▶ 広告システム /r/… │
 │                                                        (click計測→landingへ302) │
 └──────────────────────────────────────────────────────────────────────────────┘
```

### 計測モデル(確定)
| 指標 | 計上地点 | 意味 |
|---|---|---|
| **citation(課金)** | (A) 生成API呼び出し時(**冪等**・再呼び出しで再課金しない) | 広告が回答に「引用/配信確定」された |
| **impression(表示)** | (B) page-ads フェッチ時(=RagAds表示時) | 広告が**実際に表示**された(実表示計上・単一地点) |
| **click(クリック)** | (C) `/r/{pageId}/{slot}` アクセス時 | 広告がクリックされた |

> ⚠️ 生成API(A)は**表示を計上しない**。表示は必ず(B)で1回だけ。二重計上しない設計。

---

## 2. 媒体側 改修一覧(4点)

| # | 改修 | 対象ファイル | 目的 |
|---|---|---|---|
| 1 | 広告表示コンポーネント | `src/components/RagAds.tsx`(置換)・`MessageBox.tsx`(挿入) | 表示 + impression計測 |
| 2 | 広告取得プロキシ | `src/app/api/ads/[pageId]/route.ts`(新設) | 同一オリジン化・CORS回避 |
| 3 | クリック転送 | `next.config.mjs`(rewrite追加) | click計測(`/r/…`を広告システムへ) |
| 4 | 生成API呼び出し | `src/lib/ads/finalizeAds.ts`(新設)・`api/chat/route.ts`(呼び出し) | 配信確定(Placement作成+課金) |

---

## 3. 改修1: 広告表示(RagAds + MessageBox)

### 3.1 既存スタブの置換
- **置換対象**: `src/components/RagAds.tsx`(現状はダミーデータのスタブ・props無し・未配線)。
- **置換内容**: `integration/newfan-finance/RagAds.tsx`(本キット)。Perplexica の Tailwind トークン
  (`light-`/`dark-`)対応済み。0件collapse・3秒タイムアウト・高さ予約(CLS対策)・全文エスケープ・
  計測URL経由リンク(`rel="nofollow sponsored noopener"`)・「広告」ラベル常時表示(景表法対応)を実装済み。

### 3.2 MessageBox.tsx への挿入
`src/components/MessageBox.tsx` の **Related ブロック直前**(現行 157行目付近、`{isLast && section.suggestions && …` の直前)に挿入する。回答本文・Sources・Answer・Related の既存表示は改変しない。

```tsx
import RagAds from './RagAds'; // ファイル冒頭のimport群に追加

// 回答本文(Markdown)の後、Related ブロックの直前に挿入:
{section.assistantMessage && (!isLast || !loading) && (
  <RagAds pageId={section.assistantMessage.messageId} />
)}
```

- **表示条件の注意**: `!loading` は useChat のグローバル loading。最終セクションのストリーミング中に
  過去セクションの広告まで隠れるのを避けるため **`(!isLast || !loading)`** とする(最終セクションは確定後のみ表示)。
- `pageId` は **必ず** `section.assistantMessage.messageId`(改修4の生成API と同一値にする)。

### 3.3 ⚠️ 非同期生成とのタイミング(重要)
生成API(改修4)は分類+埋め込み+候補検索+リード文生成で **2〜7秒**かかる。RagAds がマウント直後に
1回だけ page-ads をフェッチすると、**Placement 生成が間に合わず 0件 → collapse で広告が出ない**恐れがある。

対策(いずれか、または併用):
1. **生成APIを早めに呼ぶ**(改修4参照。回答完了 `stream.on('end')` ではなく **`sources` 受信時**に呼ぶと数秒早い)。
2. **RagAds に軽いリトライを追加**(推奨): 0件時に 1.5〜2秒間隔で最大3〜4回 page-ads を再フェッチし、
   出た時点で確定・出なければ collapse。キットの `RagAds.tsx` は単発フェッチのため、下記の要領で拡張する。

```tsx
// RagAds.tsx の useEffect を「0件なら数回リトライ」に拡張する擬似コード
const MAX_TRIES = 4, INTERVAL = 1800;
let tries = 0;
const poll = async () => {
  const res = await fetch(`${apiBase}/${encodeURIComponent(pageId)}`, { cache: 'no-store', signal });
  const data = res.ok ? await res.json() : { ads: [] };
  if ((data.ads?.length ?? 0) > 0 || ++tries >= MAX_TRIES) {
    setState({ phase: 'resolved', ads: data.ads ?? [] });   // 確定
  } else {
    setTimeout(poll, INTERVAL);                              // まだ生成待ち → 再試行
  }
};
```
> リトライで page-ads を複数回叩いても、**impression は「実際に広告が返った表示」から計上**される
> (0件フェッチでは何も計上されない)。過剰計上にはならないが、リトライ間隔は 1.5秒以上を推奨。

---

## 4. 改修2: 広告取得プロキシ(`/api/ads/[pageId]`)

- **新設**: `src/app/api/ads/[pageId]/route.ts` ← `integration/newfan-finance/api-ads-route.ts`。
- 役割: RagAds → `GET /api/ads/{pageId}` を広告システム `GET {RAG_ADS_API_BASE}/v1/pages/{pageId}/ads` へ
  サーバー側プロキシ(CORS回避・`Cache-Control: no-store` 維持・失敗時フェイルセーフ空配列)。
- pageId 検証は **`/^[0-9a-zA-Z_-]{8,64}$/`**(決定C対応済み。修正反映済み)。
- 環境変数 `RAG_ADS_API_BASE` を参照。

---

## 5. 改修3: クリック転送(`/r/…` → 広告システム)

RagAds のカードは `clickUrl = /r/{pageId}/{slot}`(媒体オリジン相対)でリンクする。これを広告システムの
クリック計測エンドポイントへ転送する(決定D)。計測後、広告主 landingUrl へ **302** される。

**推奨: Next.js rewrite**(`next.config.mjs` / `next.config.js`)。

```js
async rewrites() {
  return [
    {
      source: '/r/:path*',
      destination: `${process.env.RAG_ADS_API_BASE}/r/:path*`,
    },
  ];
}
```

- rewrite なら 302 レスポンスがそのままクライアントへ返り、landingUrl へ遷移する。
- `RAG_ADS_API_BASE` はビルド時に解決される点に注意(サーバー環境変数)。動的にしたい場合は
  `src/app/r/[pageId]/[slot]/route.ts` を新設し、広告システムへ `fetch(..., { redirect: 'manual' })`
  して 302 の `Location` を返すプロキシにしてもよい。
- **オープンリダイレクト対策は広告システム側で実施済み**(landingUrl は Placement スナップショットの値のみ)。

---

## 6. 改修4: 生成API呼び出し(配信の起点)

**これを実装しないと Placement が作られず、page-ads は常に空=広告は一切出ない。** 配信の起点。

### 6.1 ヘルパー新設
`src/lib/ads/finalizeAds.ts` ← `integration/newfan-finance/chat-route-generate-ads.ts`。
`POST {RAG_ADS_API_BASE}/v1/pages/{pageId}/generate-ads` を **fire-and-forget・タイムアウト・冪等・
フェイルセーフ**で呼ぶ。ボディ: `{ question, articleContentIds?, questionVector? }`、ヘッダ `X-Api-Key`。

### 6.2 呼び出し位置(`src/app/api/chat/route.ts`)
`handleEmitterEvents` 内。生成APIは**回答本文を必要としない**(質問+記事IDのみ使用)ため、**`sources` 受信時**に
呼ぶのが最速で、RagAds マウントまでに Placement を用意しやすい(3.3節のタイミング対策)。

```ts
// route.ts: aiMessageId は既存(106行目 crypto.randomBytes(7).toString('hex'))。これが pageId。
import { finalizeAds } from '@/lib/ads/finalizeAds';

// stream.on('data') の 'sources' 分岐(122〜144行目付近)で、sources 保存に続けて:
} else if (parsedData.type === 'sources') {
  // …既存の writer.write / db.insert(source)…
  const sources = parsedData.data as Array<{ metadata?: { article_id?: string } }>;
  void finalizeAds({
    pageId: aiMessageId,                                   // ← RagAds と同一
    question: /* ユーザーの質問 */,                          // 6.3参照
    articleContentIds: sources
      .map((s) => s.metadata?.article_id)
      .filter((x): x is string => !!x),                    // 紐づけ加点用(任意)
    // questionVector: 省略可(広告側が同一Geminiで再埋め込み。6.4参照)
  });
}
```

> `void` を付けて **await しない**(fire-and-forget)。回答レイテンシに影響させない。冪等なので
> `sources` が複数回来ても再課金されない。

### 6.3 question の受け渡し
`handleEmitterEvents(stream, writer, encoder, chatId)` は現状 `chatId` までしか受けていない。
**ユーザーの質問文(`message.content`)を引数に追加**して渡す(POST ハンドラ 344〜358行目):
```ts
// POST内: handler.searchAndAnswer に渡している message.content を、handleEmitterEvents にも渡す
handleEmitterEvents(stream, writer, encoder, message.chatId, message.content);
// 関数シグネチャに question を追加し、finalizeAds に渡す
```

### 6.4 articleContentIds と questionVector(いずれも任意)
- **articleContentIds**: source の `metadata.article_id`(= url_hash = DynamoDB PK。`s3-vectors-search.ts`)。
  紐づけ加点(link boost)に使う。**広告システム側の記事(content)レコードが同じ article_id で登録されている場合のみ加点**。
  未登録なら無視されるだけで無害。初期は best-effort で渡してよい(空でも配信は成立)。
- **questionVector**: 決定A-1の最適化(媒体のGemini質問埋め込みを渡し広告側の再埋め込みを省略)。
  ただし質問埋め込みは `s3-vectors-search.ts:120` の内部で計算されルートに露出していない。
  **初期実装では省略推奨**(広告システムが同一 `gemini-embedding-001/3072` で再埋め込み。結果は同一空間)。
  将来、検索エージェントから query embedding を surface できたら渡してレイテンシ/コストを削減。

---

## 7. 環境変数(媒体 .env / ホスティング)

```
RAG_ADS_API_BASE=https://r29apdxkdc.execute-api.ap-northeast-1.amazonaws.com  # 本番は別途
RAG_ADS_SERVICE_API_KEY=<SSM /rag_ads/{env}/service_api_key の値>              # 生成APIのX-Api-Key
```
- `RAG_ADS_SERVICE_API_KEY` は**サーバー側のみ**で使用(chat route)。クライアントへ露出させない。
- プロキシ(改修2)と rewrite(改修3)は `RAG_ADS_API_BASE` を参照。

---

## 8. 実装手順(新セッション向けチェックリスト)

1. [ ] 環境変数 `RAG_ADS_API_BASE` / `RAG_ADS_SERVICE_API_KEY` を設定。
2. [ ] `src/components/RagAds.tsx` をキット版で置換(3.3のリトライ拡張を適用)。
3. [ ] `src/app/api/ads/[pageId]/route.ts` を新設(キット `api-ads-route.ts`)。
4. [ ] `next.config.mjs` に `/r/:path*` rewrite を追加(改修3)。
5. [ ] `src/lib/ads/finalizeAds.ts` を新設(キット `chat-route-generate-ads.ts`)。
6. [ ] `src/app/api/chat/route.ts`: `handleEmitterEvents` に question を渡し、`sources` 受信時に
       `finalizeAds` を呼ぶ(改修4)。
7. [ ] `src/components/MessageBox.tsx`: import 追加 + Related 直前に `<RagAds pageId={…} />` 挿入。
8. [ ] **フラグOFFのまま**(広告システム `enabled=false`)ビルド・デプロイ → 既存機能に無影響を確認(縮退で広告非表示)。
9. [ ] 広告システムを `enabled=true`(社内/自分のみ)にして E2E 検証(9章)。
10. [ ] 検証後 `enabled=false` に戻し、段階公開(10章)へ。

---

## 9. QA / 検証チェックリスト(エンタープライズ品質)

ブラウザ実操作で確認する(広告システム `enabled=true` の状態)。

- [ ] **配信**: 住宅ローン借り換え等の関連質問 → 回答下(Related直上)に「スポンサー」ブロックと広告カードが出る。
- [ ] **非関連**: NISA/iDeCo 等 → 広告 0件で**ブロックごと非表示**(collapse)、レイアウト崩れなし(CLS無)。
- [ ] **表示計測(1回)**: 1回の閲覧で該当広告の `impressions` が **+1**(生成では増えない)。
      リロードで再フェッチ → さらに +1。管理コンソール(レポート)or DynamoDB で確認。
- [ ] **クリック計測**: カードクリック → `/r/{pageId}/{slot}` 経由で広告主 landingUrl へ 302 遷移、`clicks` が **+1**。
- [ ] **二重計上なし**: 生成直後の `impressions=0`、表示1回で `=1`(本広告システムでE2E実証済みの挙動)。
- [ ] **フェイルセーフ**: 広告APIを一時的に不通(URL誤り等)にしても**回答本文は正常表示**、広告のみ非表示。
- [ ] **ラベル**: 全カードに「広告」ラベル(オレンジ)が常時表示(景表法・ステマ規制)。
- [ ] **エスケープ**: 広告リード文/タイトルが React 既定エスケープで描画(HTML注入されない)。
- [ ] **pageId 整合**: 生成API と RagAds/clickUrl の pageId が同一(messageId)。

---

## 10. 段階公開(ロールバックはフラグOFF)

| 段階 | 対象 | 操作 | 次段階判定 |
|---|---|---|---|
| 0 | 改修をフラグOFFで先行導入 | 広告システム `enabled=false` のまま媒体リリース | スモーク通過・既存機能無影響 |
| 1 | 社内のみON | `enabled=true` + 対象限定 | 表示崩れ/アラームなし数日 |
| 2 | 実トラフィック10% | pageIdハッシュ等で判定 | AdFillRate・レイテンシ・エラー率が目標内 |
| 3 | 100% | — | 検証運用へ移行 |

- **一次ロールバックはフラグOFF**(広告システム側 `PUT /v1/params {"enabled": false}`、即時・媒体デプロイ不要)。
  `enabled=false` の間は配信APIが空配列を返し RagAds は自動的に非表示(媒体無変更で縮退)。

---

## 11. 落とし穴・注意点まとめ

1. **generate-ads を呼び忘れると広告ゼロ**(page-ads は空)。改修4が配信の起点。
2. **タイミング**: 生成は数秒かかる。`sources` 受信時に呼ぶ + RagAds リトライ(3.3節)で取りこぼし防止。
3. **pageId は messageId で統一**(生成・表示・クリックすべて同一値)。
4. **サービスキーはサーバー側のみ**。クライアントへ露出させない。
5. **表示計測は page-ads のみ**。`initialAds` で初回フェッチを省くと表示が計上されないので**非推奨**(改修3=initialAds方式は使わない)。
6. **フェイルセーフ厳守**: 広告の失敗が回答を止めてはいけない(try/catch・タイムアウト・collapse)。
7. **article_id 紐づけ加点**は広告システム側の content 登録が前提。未登録でも配信は成立(加点のみ無効)。
8. **CLS対策**: RagAds は取得完了まで高さ予約(PC240/SP160px)。スケルトンは出さない。

---

## 12. 参照

- API契約・広告システム状態: `integration/HANDOVER_newfan-finance.md`
- ドロップイン参照実装: `integration/newfan-finance/RagAds.tsx` / `api-ads-route.ts` / `chat-route-generate-ads.ts` / `MessageBox.integration.md`
- 媒体側 実コード確認箇所(2026-02-09 版 newfan_finance-main):
  - pageId 生成: `src/app/api/chat/route.ts:106`(`aiMessageId`)
  - 回答/ソースイベント: `src/app/api/chat/route.ts:108-165`(`handleEmitterEvents`)
  - source 構造(`metadata.article_id/url/title`): `src/lib/aws/s3-vectors-search.ts`
  - 質問埋め込み(gemini-embedding-001): `src/lib/aws/s3-vectors-search.ts:120`
  - 表示挿入点(Related直前): `src/components/MessageBox.tsx:157`
  - RagAds スタブ(置換対象): `src/components/RagAds.tsx`
- 広告システム dev: AWSアカウント 654654601240 / ap-northeast-1
