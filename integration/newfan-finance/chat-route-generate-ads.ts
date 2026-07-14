/**
 * 広告生成の呼び出し(改修2・サービス方式=決定B)— NewFan-Finance 側に実装
 *   配置先の例: src/lib/ads/finalizeAds.ts(回答生成ルート src/app/api/chat/route.ts から呼ぶ)
 *
 * 役割: 回答が確定したタイミングで広告システムの生成API を呼び、広告パイプライン
 *   (G-1〜G-10)を実行して Placement を確定・課金する。これを呼ばないと page-ads は常に空で、
 *   RagAds は何も表示しない(生成=配信の起点)。
 *
 * 設計上の要点:
 *   - **pageId は RagAds に渡すものと必ず同一**(= assistantMessage.messageId。決定C)。
 *   - **表示計測(impressions)はここでは発生しない**。実表示は RagAds→page-ads フェッチ時に計上。
 *     本APIは「配信確定(citations=課金)」のみを行う。
 *   - **回答生成をブロックしない**フェイルセーフ(fire-and-forget / タイムアウト / 例外握り潰し)。
 *     広告処理の失敗が回答表示を妨げてはならない(BD-001 3.4節)。
 *   - **冪等**: 同一 pageId の再呼び出しは再課金しない(リトライやストリーム再開でも安全)。
 *   - 決定A-1(Gemini統一): 媒体が回答生成で得た Gemini 質問埋め込みを `questionVector` に渡すと、
 *     広告システム側の再埋め込みを省ける(次元は広告インデックスと一致=3072)。
 *
 * 環境変数(媒体側 .env / ホスティング):
 *   RAG_ADS_API_BASE         例) https://api.finance.newfan.co.jp もしくは execute-api の URL
 *   RAG_ADS_SERVICE_API_KEY  広告システムのサービス間APIキー(SSM /rag_ads/{env}/service_api_key)
 */

type FinalizeAdsInput = {
  /** 回答ページID。RagAds と同一の assistantMessage.messageId を渡す。 */
  pageId: string;
  /** ユーザーの質問文(必須)。 */
  question: string;
  /** 回答に使用した記事の contentId 群(紐づけ加点・任意)。 */
  articleContentIds?: string[];
  /** 媒体の Gemini 質問埋め込み(決定A-1。任意。渡すと広告側の再埋め込みを省略)。 */
  questionVector?: number[];
};

const RAG_ADS_API_BASE = process.env.RAG_ADS_API_BASE ?? '';
const RAG_ADS_SERVICE_API_KEY = process.env.RAG_ADS_SERVICE_API_KEY ?? '';
const TIMEOUT_MS = 8000; // 生成は分類+埋め込み+リード文生成を含むため配信APIより長め

/**
 * 回答確定後に呼ぶ。広告生成をトリガーするだけで、戻り値(ads[])は使わなくてよい
 * (RagAds が page-ads で取得・表示するため)。await してもしなくてもよい。
 */
export async function finalizeAds(input: FinalizeAdsInput): Promise<void> {
  if (!RAG_ADS_API_BASE || !RAG_ADS_SERVICE_API_KEY) return; // 未設定時は何もしない(縮退)
  if (!/^[0-9a-zA-Z_-]{8,64}$/.test(input.pageId) || !input.question) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(
      `${RAG_ADS_API_BASE}/v1/pages/${encodeURIComponent(input.pageId)}/generate-ads`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Api-Key': RAG_ADS_SERVICE_API_KEY,
        },
        body: JSON.stringify({
          question: input.question,
          articleContentIds: input.articleContentIds ?? [],
          ...(input.questionVector ? { questionVector: input.questionVector } : {}),
        }),
        cache: 'no-store',
        signal: ctrl.signal,
      },
    );
    // 応答本文は使わない(フラグOFF・広告なし・失敗はいずれも 200 空配列)。
  } catch {
    // タイムアウト・通信失敗は無視(回答表示を妨げない)。
  } finally {
    clearTimeout(timer);
  }
}

/*
 * 呼び出し例(src/app/api/chat/route.ts の回答確定処理内):
 *
 *   import { finalizeAds } from '@/lib/ads/finalizeAds';
 *
 *   // assistantMessage を保存し messageId が確定した後:
 *   //  - awaitせず fire-and-forget にすると回答レイテンシに影響しない
 *   //  - questionVector は回答生成で既に計算した Gemini 埋め込みを流用(決定A-1)
 *   void finalizeAds({
 *     pageId: assistantMessage.messageId,
 *     question: userQuery,
 *     articleContentIds: usedSources.map((s) => s.contentId),
 *     questionVector: geminiQueryEmbedding, // 無ければ省略可(広告側が自前で埋め込む)
 *   });
 *
 * 注意: RagAds には同じ messageId を渡すこと。
 *   <RagAds pageId={assistantMessage.messageId} />
 */
