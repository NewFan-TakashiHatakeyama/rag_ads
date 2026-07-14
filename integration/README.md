# NewFan-Finance 媒体側繋ぎ込みキット

finance.newfan.co.jp への RAG広告配信システム組み込みの**参照実装**。
**すべてフィーチャーフラグOFF(`/rag_ads/{env}/enabled = false`)のまま先行導入する**(DD-001 13.2 段階0)。

> ⚠️ **実コードベース(zip提供分)を精査し、設計書想定との乖離を反映済み。**
> 詳細・意思決定事項は **[`HANDOVER_newfan-finance.md`](HANDOVER_newfan-finance.md)** を参照。
> 設計書はPython回答生成Lambdaを想定していたが、実体は **Perplexica(Next.js/LangChain)** であり、
> 記事埋め込みは **Gemini 3072次元**(広告システムのBedrock Titan 1024次元と非互換)。

## ファイル構成

| ファイル | 用途 |
|---|---|
| `HANDOVER_newfan-finance.md` | **引継ぎ資料(主文書)**。実態・改修3点・意思決定事項・API契約・段階公開 |
| `newfan-finance/RagAds.tsx` | 既存 `src/components/RagAds.tsx`(ダミースタブ)の置換。Perplexica準拠の広告ブロック |
| `newfan-finance/api-ads-route.ts` | `src/app/api/ads/[pageId]/route.ts` 新設。広告取得の同一オリジンプロキシ |
| `newfan-finance/MessageBox.integration.md` | `MessageBox.tsx` の Related直上への挿入手順 |
| `AdSlotBlock.tsx` / `AdSlotBlock.module.css` | 汎用React版(Perplexica以外のNext.js向け参考。実導入は `newfan-finance/RagAds.tsx` を使用) |

## 媒体側改修(3点。BD-001 3.4節)

1. **回答ページへの広告表示(FE-01)**: `newfan-finance/RagAds.tsx` で既存スタブを置換し、
   `MessageBox.tsx` の Related直上へ挿入。広告取得プロキシ `api-ads-route.ts` を新設。
2. **回答生成時の広告確定(パイプライン G-1〜G-10)**: 実行場所は要決定(引継ぎ資料 決定B)。
   サービス方式(広告システムの生成エンドポイント呼び出し)を推奨。**仕様の正**はローカル実装
   `server/pipeline.js` とテスト48件(`tests/`)。
3. **(任意)回答レスポンスへの ads[] 付加**: 初回フェッチ省略の最適化(DD-001 2.5節)。

## 着手前の決定事項(引継ぎ資料 3章)

- **決定A(最重要)**: 埋め込みモデルの整合。媒体Gemini 3072 と広告Bedrock Titan 1024 の非互換を
  どう解消するか。広告システムは Gemini 3072 への切替に**対応済み**(`-c embedProvider=gemini
  -c embedDimension=3072 -c geminiApiKey=...` + 広告インデックス3072再構築)。
- **決定B**: 広告パイプラインの実行場所(サービス方式 / インライン)。
- **決定C**: pageId の粒度(`assistantMessage.messageId` 推奨)。
- **決定D**: 計測URL `/r/` の媒体ドメイン配置。

## デプロイ・ロールバック

- フラグOFFのまま導入 → スモーク → 段階1(社内ON)→ 段階2(10%)→ 段階3(100%)。
- ロールバック一次手段は `PUT /v1/params {"enabled": false}`(即時)。OFF中は配信APIが空配列を返し
  広告ブロックは自動非表示(媒体側変更なしで縮退)。
