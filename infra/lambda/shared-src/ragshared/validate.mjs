/**
 * 広告入力バリデーション(DD-001 6.3.1)。エラー文言はSD-001 付録A.1と同一。
 * ローカルPoC server/validate.js を移植(サーバー側検証が正)。
 */
import { jstDate } from './util.mjs';

export const CATEGORIES = ['金融・投資', '保険', 'ローン・クレジット', '不動産', 'その他'];
export const QUESTION_TYPE_VALUES = ['情報検索', '相談', 'アクション', '提案要求'];

const HTML_TAG = /<[a-zA-Z/!]/;
const URL_IN_TEXT = /https?:\/\/|www\./i;
const DATE_FMT = /^\d{4}-\d{2}-\d{2}$/;

function isHttpsUrl(v) {
  if (typeof v !== 'string' || v.length > 2000) return false;
  try { return new URL(v).protocol === 'https:'; } catch { return false; }
}
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

export function validateAd(body, { draft = false } = {}) {
  const errors = [];
  const push = (field, reason) => errors.push({ field, reason });
  const has = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

  if (typeof body.title !== 'string' || body.title.length < 1 || body.title.length > 50 || HTML_TAG.test(body.title)) {
    push('title', '広告タイトル：1〜50文字で入力してください');
  }
  if (has(body.category) || !draft) {
    if (!CATEGORIES.includes(body.category)) push('category', '広告カテゴリ：選択してください');
  }
  if (has(body.adText) || !draft) {
    if (typeof body.adText !== 'string' || body.adText.length < 100 || body.adText.length > 500) {
      push('adText', '広告テキスト：100〜500文字で入力してください');
    } else if (HTML_TAG.test(body.adText) || URL_IN_TEXT.test(body.adText)) {
      push('adText', '広告テキスト：URLやHTMLタグは使用できません');
    }
  }
  if (has(body.landingUrl) || !draft) {
    if (!isHttpsUrl(body.landingUrl)) push('landingUrl', '遷移先URL：httpsのURLを入力してください');
  }
  if (has(body.imageUrl)) {
    if (!isHttpsUrl(body.imageUrl)) push('imageUrl', '広告画像URL：httpsのURLを入力してください');
  }
  if (has(body.tags)) {
    if (!Array.isArray(body.tags) || body.tags.length > 5) push('tags', '専門分野タグ：5件以内で入力してください');
    else if (body.tags.some((t) => typeof t !== 'string' || t.length < 1 || t.length > 20)) push('tags', '専門分野タグ：各項目は1〜20文字で入力してください');
  }
  if (has(body.keywords)) {
    if (!Array.isArray(body.keywords) || body.keywords.length > 10) push('keywords', '関連キーワード：10件以内で入力してください');
    else if (body.keywords.some((t) => typeof t !== 'string' || t.length < 1 || t.length > 20)) push('keywords', '関連キーワード：各項目は1〜20文字で入力してください');
  }
  if (has(body.target)) {
    const t = body.target;
    if (typeof t !== 'object' || Array.isArray(t)) push('target', 'ターゲット設定：形式が不正です');
    else {
      if (t.ageRange !== undefined && t.ageRange !== null) {
        const okr = Array.isArray(t.ageRange) && t.ageRange.length === 2
          && t.ageRange.every((n) => isInt(n) && n >= 18 && n <= 99) && t.ageRange[0] <= t.ageRange[1];
        if (!okr) push('target', 'ターゲット設定：年齢は18〜99の範囲で下限≦上限としてください');
      }
      if (t.questionTypes !== undefined && t.questionTypes !== null) {
        const okq = Array.isArray(t.questionTypes) && t.questionTypes.every((v) => QUESTION_TYPE_VALUES.includes(v));
        if (!okq) push('target', 'ターゲット設定：質問内容タイプの値が不正です');
      }
    }
  }
  if (has(body.unitPriceCitation) || !draft) {
    if (!isInt(body.unitPriceCitation) || body.unitPriceCitation < 1 || body.unitPriceCitation > 1000) {
      push('unitPriceCitation', '引用単価：1〜1,000の整数で入力してください');
    }
  }
  const hasPeriod = has(body.campaignStart) || has(body.campaignEnd);
  if (hasPeriod || !draft) {
    const startOk = typeof body.campaignStart === 'string' && DATE_FMT.test(body.campaignStart) && !Number.isNaN(Date.parse(body.campaignStart));
    const endOk = typeof body.campaignEnd === 'string' && DATE_FMT.test(body.campaignEnd) && !Number.isNaN(Date.parse(body.campaignEnd));
    if (!startOk || !endOk) {
      push('campaignStart', 'キャンペーン期間：YYYY-MM-DD形式で開始日・終了日を入力してください');
    } else {
      if (body.campaignStart > body.campaignEnd) push('campaignEnd', 'キャンペーン期間：終了日は開始日以降の日付を指定してください');
      if (body.campaignEnd < jstDate()) push('campaignEnd', 'キャンペーン期間：終了日は本日以降の日付を指定してください');
    }
  }
  if (has(body.dailyBudget) || !draft) {
    if (!isInt(body.dailyBudget) || body.dailyBudget < 100 || body.dailyBudget > 1000000) {
      push('dailyBudget', '日次予算上限：100〜1,000,000の整数で入力してください');
    } else if (isInt(body.unitPriceCitation) && body.dailyBudget < body.unitPriceCitation) {
      push('dailyBudget', '日次予算上限：引用単価以上の金額を指定してください');
    }
  }
  return errors;
}

export function pickAdAttributes(body) {
  return {
    title: body.title,
    category: body.category ?? null,
    adText: body.adText ?? null,
    landingUrl: body.landingUrl ?? null,
    imageUrl: body.imageUrl || null,
    tags: Array.isArray(body.tags) ? body.tags : [],
    keywords: Array.isArray(body.keywords) ? body.keywords : [],
    target: normalizeTarget(body.target),
    billingModel: 'citation',
    unitPriceCitation: body.unitPriceCitation ?? null,
    campaignStart: body.campaignStart ?? null,
    campaignEnd: body.campaignEnd ?? null,
    dailyBudget: body.dailyBudget ?? null,
  };
}

function normalizeTarget(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const out = {};
  if (Array.isArray(t.ageRange) && t.ageRange.length === 2) out.ageRange = [t.ageRange[0], t.ageRange[1]];
  if (typeof t.region === 'string' && t.region) out.region = t.region;
  if (Array.isArray(t.interests)) out.interests = t.interests;
  if (Array.isArray(t.questionTypes)) out.questionTypes = t.questionTypes;
  return Object.keys(out).length ? out : null;
}
