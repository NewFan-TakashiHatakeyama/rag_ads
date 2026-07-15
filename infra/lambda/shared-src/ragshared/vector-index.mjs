/**
 * S3 Vectors 広告インデックス(DD-001 5.4節)。
 * 承認時Put / 内容更新時Put(上書き) / 停止・期限切れ・削除時Delete。
 * 検索: top-k=candidate_topk、フィルタ status=delivering AND 期間内。
 *
 * S3 Vectorsの数値メタデータフィルタを使うため、キャンペーン期間はYYYYMMDD整数で保持する
 * (文字列の範囲比較は非対応のため。util.dateToNum)。
 */
import {
  S3VectorsClient, PutVectorsCommand, DeleteVectorsCommand, QueryVectorsCommand, GetVectorsCommand,
} from '@aws-sdk/client-s3vectors';
import { dateToNum } from './util.mjs';

const s3v = new S3VectorsClient({});
const BUCKET = process.env.RAG_Ads_VECTOR_BUCKET;
const INDEX = process.env.RAG_Ads_VECTOR_INDEX;

/** 広告ベクトルをPut(承認・内容更新時)。metadataはすべてフィルタ可能属性(5.4節) */
export async function putVector(ad, vector) {
  await s3v.send(new PutVectorsCommand({
    vectorBucketName: BUCKET,
    indexName: INDEX,
    vectors: [{
      key: ad.adId,
      data: { float32: vector },
      metadata: {
        adId: ad.adId,
        category: ad.category ?? '',
        status: 'delivering',
        advertiserId: ad.advertiserId ?? '',
        unitPrice: ad.unitPriceCitation ?? 0,
        campaignStartNum: dateToNum(ad.campaignStart),
        campaignEndNum: dateToNum(ad.campaignEnd),
      },
    }],
  }));
}

export async function deleteVector(adId) {
  await s3v.send(new DeleteVectorsCommand({ vectorBucketName: BUCKET, indexName: INDEX, keys: [adId] }));
}

/**
 * 紐づけ候補の記事検索(S-03・6.3.2): 媒体の記事ベクトル索引を広告ベクトルでANN検索する。
 * 記事は媒体側で埋め込み済み(決定A-1で同一のGemini空間)のため、広告1本を埋め込むだけでよく、
 * 記事件数に依存しない(従来の「全記事を都度埋め込み」はO(N)でスケールしなかった)。
 * 返す contentId は媒体の article_id。generate-ads が受け取る articleContentIds と同一体系のため、
 * 紐づけ加点(linkBoost)が実トラフィックで一致する。
 * @returns {Promise<Array<{contentId,title,genre,url,relevance}>|null>} 索引未設定時は null(呼び出し側でフォールバック)
 */
export async function queryContentCandidates(adVector, topK) {
  const bucket = process.env.RAG_Ads_CONTENT_VECTOR_BUCKET;
  const index = process.env.RAG_Ads_CONTENT_VECTOR_INDEX;
  if (!bucket || !index) return null;
  const r = await s3v.send(new QueryVectorsCommand({
    vectorBucketName: bucket,
    indexName: index,
    queryVector: { float32: adVector },
    topK,
    returnMetadata: true,
    returnDistance: true,
  }));
  const seen = new Set();
  const out = [];
  for (const v of r.vectors ?? []) {
    const m = v.metadata ?? {};
    const contentId = m.article_id ?? v.key;
    if (!contentId || seen.has(contentId)) continue; // 記事が複数チャンクを持つ場合の重複排除
    seen.add(contentId);
    out.push({
      contentId,
      title: m.title ?? '',
      genre: m.category ?? '',
      url: m.url ?? '',
      pubDate: m.pub_date ?? '', // 記事の新しさによる足切りに使う(YYYY-MM-DD)
      relevance: 1 - (v.distance ?? 1), // cosine距離→類似度
    });
  }
  return out;
}

/**
 * 記事1件のベクトルを媒体の索引から取得(S-03-1の関連度算出用)。
 * 一覧(ANN)と同じ「媒体が保存済みのベクトル」を使うことで、一覧と詳細の関連度が一致する。
 * @returns {Promise<number[]|null>} 索引未設定・該当なしは null
 */
export async function getContentVector(contentId) {
  const bucket = process.env.RAG_Ads_CONTENT_VECTOR_BUCKET;
  const index = process.env.RAG_Ads_CONTENT_VECTOR_INDEX;
  if (!bucket || !index) return null;
  try {
    const r = await s3v.send(new GetVectorsCommand({
      vectorBucketName: bucket, indexName: index, keys: [contentId], returnData: true,
    }));
    return r.vectors?.[0]?.data?.float32 ?? null;
  } catch {
    return null; // 該当なし等は縮退(呼び出し側で再埋め込みにフォールバック)
  }
}

/**
 * 質問ベクトルで候補検索(G-3)。status=delivering AND 期間内でフィルタ。
 * @returns {Array<{adId, sim}>} cosine距離を1-distanceで類似度へ変換
 */
export async function queryCandidates(queryVector, topK, today) {
  const todayNum = dateToNum(today);
  const r = await s3v.send(new QueryVectorsCommand({
    vectorBucketName: BUCKET,
    indexName: INDEX,
    queryVector: { float32: queryVector },
    topK,
    returnMetadata: true,
    returnDistance: true,
    filter: {
      $and: [
        { status: { $eq: 'delivering' } },
        { campaignStartNum: { $lte: todayNum } },
        { campaignEndNum: { $gte: todayNum } },
      ],
    },
  }));
  return (r.vectors ?? []).map((v) => ({
    adId: v.metadata?.adId ?? v.key,
    sim: 1 - (v.distance ?? 1),
  }));
}
