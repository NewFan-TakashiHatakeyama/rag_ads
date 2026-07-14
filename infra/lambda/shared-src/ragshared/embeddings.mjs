/**
 * 埋め込み生成(DD-001 3.3節/7.1節)。
 * 記事・広告・質問で同一モデルを共用し同一の意味空間で検索する(BD-001 3.3節)。
 *
 * プロバイダ切替(媒体NewFan-Financeの embedding-client と同一の思想):
 *   RAG_Ads_EMBED_PROVIDER  = 'bedrock'(既定・自立稼働) | 'gemini'
 *   RAG_Ads_EMBED_MODEL_ID  = Bedrockモデル(bedrock時)
 *   RAG_Ads_EMBED_DIMENSION = 出力次元(既定 bedrock=1024)
 *   RAG_Ads_GEMINI_API_KEY  = Geminiキー(gemini時)
 *
 * 【重要・本番整合】媒体は gemini-embedding-001 / 3072次元 を使用する。広告を媒体の
 * 質問埋め込みと同一空間で検索するには、広告システムも provider=gemini・dimension=3072 に
 * 揃え、S3 Vectorsインデックスを3072次元で作り直す必要がある(引継ぎ資料参照)。
 * dev単体検証では bedrock/1024 のまま独立稼働できる。
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const PROVIDER = process.env.RAG_Ads_EMBED_PROVIDER || 'bedrock';
const BEDROCK_MODEL = process.env.RAG_Ads_EMBED_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const DIMENSION = parseInt(process.env.RAG_Ads_EMBED_DIMENSION || (PROVIDER === 'gemini' ? '3072' : '1024'), 10);
const GEMINI_API_KEY = process.env.RAG_Ads_GEMINI_API_KEY || '';

let bedrock = null;
const getBedrock = () => (bedrock ??= new BedrockRuntimeClient({}));

/** Bedrock Titan Embed v2(正規化) */
async function embedBedrock(text) {
  const r = await getBedrock().send(new InvokeModelCommand({
    modelId: BEDROCK_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ inputText: String(text ?? '').slice(0, 8000), dimensions: DIMENSION, normalize: true }),
  }));
  return JSON.parse(new TextDecoder().decode(r.body)).embedding;
}

/**
 * Gemini gemini-embedding-001(媒体 embedding-client と同一エンドポイント・モデル・次元指定)。
 * Matryoshka対応(3072/1536/768)。媒体の記事ベクトルと同一空間になる。
 */
async function embedGemini(text) {
  if (!GEMINI_API_KEY) throw new Error('RAG_Ads_GEMINI_API_KEY 未設定(provider=gemini)');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text: String(text ?? '').slice(0, 8000) }] },
      outputDimensionality: DIMENSION,
    }),
  });
  if (!res.ok) throw new Error(`Gemini Embedding API error: ${res.status} ${await res.text().catch(() => '')}`);
  const data = await res.json();
  const values = data?.embedding?.values;
  if (!Array.isArray(values)) throw new Error(`Unexpected Gemini response: ${JSON.stringify(data).slice(0, 200)}`);
  return values;
}

/** テキスト → 埋め込みベクトル(float32配列)。プロバイダは env で切替 */
export async function embed(text) {
  return PROVIDER === 'gemini' ? embedGemini(text) : embedBedrock(text);
}

/** 現在の埋め込み設定(インデックス次元整合チェック等に使用) */
export const embedInfo = { provider: PROVIDER, dimension: DIMENSION, model: PROVIDER === 'gemini' ? 'gemini-embedding-001' : BEDROCK_MODEL };

/** 広告のベクトル化対象: title＋adText＋keywords＋tags(区切りは全角読点。DD-001 5.4節) */
export function adEmbeddingText(ad) {
  return [ad.title, ad.adText, ...(ad.keywords ?? []), ...(ad.tags ?? [])].filter(Boolean).join('、');
}

/** 記事のベクトル化対象: title＋genre＋本文先頭 */
export function contentEmbeddingText(c) {
  return [c.title, c.genre, (c.body ?? '').slice(0, 600)].filter(Boolean).join('、');
}
