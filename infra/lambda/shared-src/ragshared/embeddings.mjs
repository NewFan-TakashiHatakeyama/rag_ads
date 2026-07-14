/**
 * 埋め込み生成(DD-001 3.3節/7.1節)。Bedrock Titan Embed v2(1024次元・正規化)。
 * 記事・広告・質問で同一モデルを共用し、同一の意味空間で検索する(BD-001 3.3節)。
 * ローカルPoC server/vector.js の adEmbeddingText/contentEmbeddingText と同一のテキスト構成。
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const bedrock = new BedrockRuntimeClient({});
const EMBED_MODEL = process.env.RAG_Ads_EMBED_MODEL_ID || 'amazon.titan-embed-text-v2:0';
const DIMENSIONS = 1024;

/** テキスト → 1024次元の正規化埋め込みベクトル(float32配列) */
export async function embed(text) {
  const r = await bedrock.send(new InvokeModelCommand({
    modelId: EMBED_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ inputText: String(text ?? '').slice(0, 8000), dimensions: DIMENSIONS, normalize: true }),
  }));
  const parsed = JSON.parse(new TextDecoder().decode(r.body));
  return parsed.embedding;
}

/** 広告のベクトル化対象: title＋adText＋keywords＋tags(区切りは全角読点。DD-001 5.4節) */
export function adEmbeddingText(ad) {
  return [ad.title, ad.adText, ...(ad.keywords ?? []), ...(ad.tags ?? [])].filter(Boolean).join('、');
}

/** 記事のベクトル化対象: title＋genre＋本文先頭 */
export function contentEmbeddingText(c) {
  return [c.title, c.genre, (c.body ?? '').slice(0, 600)].filter(Boolean).join('、');
}
