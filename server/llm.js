/**
 * LLM処理(DD-001 7章)。
 * 本番はAmazon Bedrock(Haiku級軽量モデル)を呼び出すが、ローカルPoCでは同一の
 * 入出力契約(JSONスキーマ・検証・フォールバック)を持つルールベース実装で代替する。
 * インターフェースはBedrock実装へ差し替え可能な形に保つ。
 */
import { getParams } from './config.js';

// ---- 質問分類(7.2節) ----------------------------------------------------
export const CATEGORIES = ['株式・投信', '債券・金利', 'FX・為替', '暗号資産', '保険', 'ローン・クレジット', '税金・年金', '家計・節約', '経済・市況', 'その他'];
export const QUESTION_TYPES = ['情報検索', '相談', 'アクション', '提案要求'];

const CATEGORY_KEYWORDS = [
  ['株式・投信', ['株', '株式', '投資信託', '投信', 'nisa', 'ニーサ', 'etf', '配当', 'インデックス', 'つみたて', '積立投資']],
  ['債券・金利', ['債券', '国債', '社債', '金利', '利回り', '利上げ', '利下げ']],
  ['FX・為替', ['fx', '為替', '円安', '円高', 'ドル', 'ユーロ', '外貨']],
  ['暗号資産', ['暗号資産', 'ビットコイン', '仮想通貨', 'イーサリアム', 'btc', 'nft']],
  ['保険', ['保険', '医療保険', '生命保険', '年金保険', '共済', '保険料']],
  ['ローン・クレジット', ['ローン', '住宅ローン', '借り換え', '借入', 'クレジット', 'カード', 'キャッシング', '融資', '返済']],
  ['税金・年金', ['税金', '確定申告', 'ふるさと納税', '控除', '年金', 'idec', 'ideco', '相続', '贈与']],
  ['家計・節約', ['家計', '節約', '貯金', '貯蓄', '固定費', '光熱費', 'ポイ活']],
  ['経済・市況', ['日銀', '経済', '景気', 'インフレ', 'gdp', '市況', '株価指数', '金融政策']],
];

/**
 * 質問分類。分類失敗・低confidence時は「その他/情報検索」でターゲットフィルタ未適用(7.2節)。
 * @returns {{category: string, question_type: string, confidence: number}}
 */
export function classifyQuestion(question) {
  const q = String(question ?? '').toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const [cat, kws] of CATEGORY_KEYWORDS) {
    let hits = 0;
    for (const kw of kws) if (q.includes(kw)) hits++;
    if (hits > bestHits) { best = cat; bestHits = hits; }
  }
  let type = '情報検索';
  if (/(おすすめ|お勧め|提案|どれ|どちら|どっち|選ぶべき|比較して|プランは)/.test(q)) type = '提案要求';
  else if (/(したい|始めたい|申し込|開設|購入|手続き|乗り換え|切り替え|方法を教えて)/.test(q)) type = 'アクション';
  else if (/(相談|悩ん|不安|心配|べきです|べきでしょう|どうすれば|大丈夫)/.test(q)) type = '相談';
  const confidence = best ? Math.min(1, 0.5 + bestHits * 0.2) : 0.3;
  if (!best || confidence < 0.5) {
    return { category: 'その他', question_type: type, confidence, targetFilterApplicable: false };
  }
  return { category: best, question_type: type, confidence, targetFilterApplicable: true };
}

// ---- NG表現辞書(7.4節) ---------------------------------------------------
/** 金融(金商法・貸金業法)・共通(景表法)・美容(薬機法)の代表辞書。管理者が更新する想定 */
export const NG_DICTIONARY = [
  { text: '元本保証', law: '金融商品取引法', reason: '投資商品に対する元本保証の表示は虚偽・誤認のおそれ', severity: 'high', scope: 'finance' },
  { text: '必ず儲かる', law: '金融商品取引法', reason: '断定的判断の提供にあたるおそれ', severity: 'high', scope: 'finance' },
  { text: '絶対に損しない', law: '金融商品取引法', reason: '断定的判断の提供にあたるおそれ', severity: 'high', scope: 'finance' },
  { text: '確実に増える', law: '金融商品取引法', reason: '断定的判断の提供にあたるおそれ', severity: 'high', scope: 'finance' },
  { text: '審査なし', law: '貸金業法', reason: '無審査融資の表示は違法な貸付けの誘引のおそれ', severity: 'high', scope: 'finance' },
  { text: '誰でも借りられる', law: '貸金業法', reason: '返済能力を考慮しない借入れの誘引のおそれ', severity: 'high', scope: 'finance' },
  { text: '必ず', law: '景品表示法', reason: '断定的な利益保証(優良誤認)のおそれ', severity: 'mid', scope: 'common' },
  { text: '絶対', law: '景品表示法', reason: '断定的表現(優良誤認)のおそれ', severity: 'mid', scope: 'common' },
  { text: '日本一', law: '景品表示法', reason: '根拠の表記がないNo.1表示は優良誤認のおそれ', severity: 'mid', scope: 'common' },
  { text: 'No.1', law: '景品表示法', reason: '根拠の表記がないNo.1表示は優良誤認のおそれ', severity: 'mid', scope: 'common' },
  { text: '業界最安', law: '景品表示法', reason: '根拠の表記がない最安表示は有利誤認のおそれ', severity: 'mid', scope: 'common' },
  { text: '今だけ', law: '景品表示法', reason: '期間限定表示は条件の明示がないと有利誤認のおそれ', severity: 'low', scope: 'common' },
  { text: 'シワが消える', law: '薬機法', reason: '化粧品の効能範囲を逸脱する表現のおそれ', severity: 'high', scope: 'beauty' },
  { text: 'アンチエイジング', law: '薬機法', reason: '老化防止効果の標ぼうは効能範囲を逸脱するおそれ', severity: 'mid', scope: 'beauty' },
  { text: '治る', law: '薬機法', reason: '医薬品的な効能効果の標ぼうのおそれ', severity: 'high', scope: 'beauty' },
  { text: '痩せる', law: '薬機法', reason: '裏付けのない痩身効果の標ぼうのおそれ', severity: 'high', scope: 'beauty' },
];

/** プロンプトインジェクション指示文パターン(11.3節) */
const INJECTION_PATTERNS = [
  /以前の指示を?無視/, /これまでの指示を?無視/, /指示を無視/, /システムプロンプト/,
  /ignore (all )?(previous|prior) instructions/i, /disregard .*instructions/i,
];

/**
 * 出稿時スクリーニング(7.4節)。ルールベース辞書照合+一次チェック(モック)。
 * 自動リジェクトは行わず、findingsとして警告を返す。
 * @returns {Array<{text: string, law: string, reason: string, severity: string}>}
 */
export function screenAd(ad) {
  const findings = [];
  const haystack = `${ad.title ?? ''}\n${ad.adText ?? ''}`;
  for (const entry of NG_DICTIONARY) {
    if (haystack.includes(entry.text)) {
      findings.push({ text: entry.text, law: entry.law, reason: entry.reason, severity: entry.severity });
    }
  }
  for (const pat of INJECTION_PATTERNS) {
    const m = haystack.match(pat);
    if (m) {
      findings.push({ text: m[0], law: '(社内規程)', reason: 'AIへの指示文(プロンプトインジェクション)の疑いがある表現', severity: 'high' });
    }
  }
  return findings;
}

/** リード文検証で常時適用する辞書(金融・共通。7.4節) */
export function leadNgHit(text) {
  for (const entry of NG_DICTIONARY) {
    if (entry.scope !== 'beauty' && text.includes(entry.text)) return entry.text;
  }
  return null;
}

// ---- リード文生成(7.3節) -------------------------------------------------
/**
 * リード文一括生成(最大3広告分を1コールで生成する想定のモック)。
 * 質問文脈(分類・一致キーワード)と広告テキストのみを材料に20〜60字の導入文を作る。
 * @returns {{leads: Array<{adId: string, lead: string}>}}
 */
export function generateLeads(ctx, ads) {
  const params = getParams();
  const maxLen = params['lead.max_chars'];
  const leads = ads.map((ad) => {
    const kw = matchKeyword(ctx.question, ad);
    const title = ad.title ?? '';
    let lead;
    if (kw) {
      lead = `${kw}をご検討中の方に、${title}のご案内です。`;
      if (lead.length > maxLen) lead = `${kw}に関連する、${title}のご案内です。`;
    } else {
      lead = `ご質問のテーマに関連する、${title}のご案内です。`;
    }
    if (lead.length > maxLen) {
      const room = maxLen - 'のご案内です。'.length;
      lead = `${title.slice(0, Math.max(4, room))}のご案内です。`;
    }
    if (lead.length < params['lead.min_chars']) {
      lead = `ご質問のテーマに関連する、${title}のご案内です。`;
    }
    return { adId: ad.adId, lead };
  });
  return { leads };
}

function matchKeyword(question, ad) {
  const q = String(question ?? '');
  const cands = [...(ad.keywords ?? []), ...(ad.tags ?? [])].filter(Boolean);
  cands.sort((a, b) => b.length - a.length); // 具体的(長い)ものを優先
  for (const kw of cands) {
    if (kw.length >= 2 && q.includes(kw)) return kw;
  }
  return null;
}

/**
 * リード文の検証(7.3節)。違反理由を返す(nullなら合格)。
 * ①スキーマ ②文字数 ③NG辞書 ④HTMLタグ・URL・改行・「広告」の混入
 */
export function validateLead(lead) {
  const params = getParams();
  if (typeof lead !== 'string' || lead.length === 0) return 'schema';
  if (lead.length < params['lead.min_chars'] || lead.length > params['lead.max_chars']) return 'length';
  if (/\n|\r/.test(lead)) return 'newline';
  if (/<[a-zA-Z/!]/.test(lead)) return 'html';
  if (/https?:\/\/|www\./i.test(lead)) return 'url';
  if (lead.includes('広告')) return 'label_word';
  if (leadNgHit(lead)) return 'ng_word';
  return null;
}
