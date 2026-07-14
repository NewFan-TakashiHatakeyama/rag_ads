# MessageBox.tsx への RagAds 挿入手順

`src/components/MessageBox.tsx` の **Related セクション直前**(= 情報源・回答の後、関連コンテンツの上)に
広告ブロックを挿入する。回答本文・Sources・Related の既存表示には手を加えない(DD-001 2.1節)。

## 1. import 追加(ファイル冒頭の import 群に)

```tsx
import RagAds from './RagAds';
```

## 2. 挿入位置

`MessageBox.tsx` の `Related` 見出しブロック(`section.suggestions` を描画する
`{isLast && section.suggestions && ... (` の直前)に、以下を挿入する。

```tsx
{/* FE-01 広告ブロック(Related直上)。回答確定後のみ表示 */}
{section.assistantMessage && !loading && (
  <RagAds pageId={section.assistantMessage.messageId} />
)}
```

### pageId について（要決定・引継ぎ資料 3章）

- 広告は**回答単位**で確定・課金されるため、`pageId` には回答ごとに一意な
  `section.assistantMessage.messageId` を用いることを推奨する（chatId は会話単位で粗い）。
- 広告システムの配信API は `pageId` を `[0-9a-zA-Z]{8,64}` 想定で検証する。Perplexica の
  messageId が16進以外を含む場合、広告システム側の pageId 検証を英数許容へ緩めるか、
  媒体側で正規化する（本キットの `api-ads-route.ts` は英数許容で実装済み）。

## 3. 環境変数(.env / config)

```
RAG_ADS_API_BASE=https://api.finance.newfan.co.jp   # 広告システムの配信APIベース
```

`RagAds` は既定で同一オリジンのプロキシ `/api/ads/{pageId}`(本キットの `api-ads-route.ts`)を叩く。
プロキシを使わず広告システムを直接叩く場合は `<RagAds pageId={...} apiBase="https://.../v1/pages" />` の
ように指定する（広告システムAPIは CORS 許可済みだが、同一オリジンプロキシ推奨）。

## 4. 既存スタブの置換

既存の `src/components/RagAds.tsx`(ダミー広告のスタブ・未使用)を、本キットの `RagAds.tsx` で置換する。

## 5. 動作

- マウント時に広告取得 → 3秒タイムアウト・0件/失敗はブロックごと非表示(collapse)・リトライなし。
- 「広告」ラベル常時表示(オレンジ)、リード文3行クランプ、計測URL経由リンク
  (`target=_blank` / `rel="nofollow sponsored noopener"`)。
- フラグOFF(広告システム側 `/rag_ads/{env}/enabled=false`)の間は配信API が空配列を返すため、
  ブロックは自動的に非表示になる(媒体側の変更なしで縮退)。
