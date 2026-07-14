/**
 * S3 Vectors 広告インデックス(DD-001 5.4節)。
 * 承認時Put / 内容更新時Put(上書き) / 停止・期限切れ・削除時Delete。
 * 検索: top-k=candidate_topk、フィルタ status=delivering AND 期間内。
 *
 * S3 Vectorsの数値メタデータフィルタを使うため、キャンペーン期間はYYYYMMDD整数で保持する
 * (文字列の範囲比較は非対応のため。util.dateToNum)。
 */
import {
  S3VectorsClient, PutVectorsCommand, DeleteVectorsCommand, QueryVectorsCommand,
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
