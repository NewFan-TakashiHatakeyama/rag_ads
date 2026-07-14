import './setup.js';
import { tables, resetAll } from '../server/store.js';
import { resetParams, setParams } from '../server/config.js';
import * as admin from '../server/adminApi.js';
import { jstDateOffset, nowIso } from '../server/util.js';

export const ADV1 = { email: 'a1@example.co.jp', role: 'advertiser', advertiserId: 'ADV-T001', name: 'テスト広告主1' };
export const ADV2 = { email: 'a2@example.co.jp', role: 'advertiser', advertiserId: 'ADV-T002', name: 'テスト広告主2' };
export const ADV3 = { email: 'a3@example.co.jp', role: 'advertiser', advertiserId: 'ADV-T003', name: 'テスト広告主3' };
export const ADMIN = { email: 'admin@newfan.co.jp', role: 'admin', advertiserId: null, name: 'テスト管理者' };

/** 100〜500字制約を満たす広告テキストを生成 */
export function adText(topic) {
  const base = `${topic}に関する情報を無料でご案内するサービスです。専門スタッフがオンラインで内容をわかりやすく説明し、比較検討に必要な資料をまとめて提供します。`;
  let s = base;
  while (s.length < 100) s += '手続きはオンラインで完結し、しつこい営業連絡は行いません。';
  return s.slice(0, 500);
}

/** 記事シード(テスト用の最小構成) */
export function seedContents() {
  const defs = [
    { contentId: 'C-LOAN', genre: 'ローン・クレジット', title: '住宅ローン借り換えの損益分岐点', body: '住宅ローンの借り換えでは、変動金利と固定金利の金利差と諸費用を含めた総返済額で比較する。'.repeat(10), summary: '借り換えは総返済額で比較します。' },
    { contentId: 'C-NISA', genre: '株式・投信', title: 'つみたて投資と積立の基本', body: 'つみたて投資は少額を長期で積み立てる。NISAの非課税枠を活用し、分散と低コストを守る。'.repeat(10), summary: '長期・分散・低コストが基本です。' },
    { contentId: 'C-FX', genre: 'FX・為替', title: '外貨預金の金利とリスク', body: '外貨預金は為替変動リスクと手数料を含めた実質利回りで判断する。'.repeat(10), summary: '実質利回りで判断します。' },
  ];
  for (const d of defs) {
    tables.contents.put({
      PK: `CONTENT#${d.contentId}`, SK: 'META', ...d,
      sources: [{ name: 'テスト出典', url: 'https://example.org/' }],
      publishedAt: nowIso(), updatedAt: nowIso(),
      baseCitationsDaily: [1, 1, 1, 1, 1, 1, 1],
    });
  }
}

/** 出稿→(承認)で広告を作る。statusに応じて遷移まで実施 */
export function makeAd(session, { status = 'delivering', title, topic, unitPrice = 10, dailyBudget = 1000, keywords = [], target, start = -1, end = 30 } = {}) {
  const body = {
    title: title ?? `${topic}のご案内`,
    category: 'ローン・クレジット',
    adText: adText(topic),
    landingUrl: 'https://www.example.co.jp/lp',
    tags: [], keywords,
    target,
    unitPriceCitation: unitPrice,
    campaignStart: jstDateOffset(start), campaignEnd: jstDateOffset(end),
    dailyBudget,
    submit: status !== 'draft',
  };
  const r = admin.createAd(session, body);
  const adId = r.body.adId;
  if (status === 'delivering' || status === 'paused' || status === 'expired') {
    admin.patchStatus(ADMIN, adId, { to: 'approved' });
  }
  if (status === 'paused') admin.patchStatus(session, adId, { to: 'paused' });
  if (status === 'expired') {
    // 期限切れは日次バッチ管轄のため直接更新
    const ad = tables.ads.get(`AD#${adId}`, 'META');
    tables.ads.put({ ...ad, status: 'expired' });
    admin.syncVector({ ...ad, status: 'expired' });
  }
  if (status === 'needs_fix') admin.patchStatus(ADMIN, adId, { to: 'needs_fix', reviewNote: 'テスト差戻し' });
  return adId;
}

/** 各テストの前処理: 全消去+パラメータ初期化 */
export function freshWorld({ theta = 0.3 } = {}) {
  resetAll();
  resetParams();
  setParams({ theta_rel: theta });
  seedContents();
}

export { admin, tables };
export { getPageAds, recordClick, runAdPipeline, answerQuestion, reserveBudget } from '../server/pipeline.js';
export { runDailyAgg } from '../server/batch.js';
export { setParams, getParams } from '../server/config.js';
export { jstDate, jstDateOffset } from '../server/util.js';
export { adVectorIndex } from '../server/store.js';
