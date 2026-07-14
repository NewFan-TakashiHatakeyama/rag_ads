/**
 * 埋め込み・類似度計算。
 * 本番設計では既存ニュースサイトと同一のBedrock埋め込みモデルを記事・広告・質問で
 * 共用する(BD-001 3.3節)。ローカルPoCでは同一の意味空間を「文字bigram+英数トークンの
 * TFベクトル」で代替し、記事・広告・質問すべてを同じ関数で埋め込む。
 */

/** テキスト → スパースTFベクトル(Map) */
export function embed(text) {
  const vec = new Map();
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/[\s、。・「」『』（）()\[\]｛｝{}!?！?？:：;；,，.．]/g, ' ');
  // 英数字トークン
  for (const m of normalized.matchAll(/[a-z0-9]+/g)) {
    const k = 'w:' + m[0];
    vec.set(k, (vec.get(k) ?? 0) + 1);
  }
  // 日本語: 文字bigram(+単字は重み低)
  const jp = normalized.replace(/[a-z0-9 ]/g, '');
  for (let i = 0; i < jp.length; i++) {
    const uni = 'u:' + jp[i];
    vec.set(uni, (vec.get(uni) ?? 0) + 0.3);
    if (i + 1 < jp.length) {
      const bi = 'b:' + jp.slice(i, i + 2);
      vec.set(bi, (vec.get(bi) ?? 0) + 1);
    }
  }
  return normalize(vec);
}

function normalize(vec) {
  let sum = 0;
  for (const v of vec.values()) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  const out = {};
  for (const [k, v] of vec) out[k] = v / norm;
  return out;
}

/**
 * 意味的類似度(0〜1)。
 * bigram TFの生コサインは埋め込みモデルのコサインより小さく出るため、平方根で
 * スケーリングし、設計書の閾値(θ_rel=0.50)・関連度%表示と整合する値域に較正する。
 */
export function similarity(a, b) {
  return Math.sqrt(cosine(a, b));
}

/** コサイン類似度(0〜1)。正規化済み前提で内積 */
export function cosine(a, b) {
  let dot = 0;
  const [small, large] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  for (const [k, v] of Object.entries(small)) {
    const w = large[k];
    if (w) dot += v * w;
  }
  return Math.max(0, Math.min(1, dot));
}

/** 広告のベクトル化対象テキスト: title＋adText＋keywords＋tags(区切りは全角読点。DD-001 5.4節) */
export function adEmbeddingText(ad) {
  return [ad.title, ad.adText, ...(ad.keywords ?? []), ...(ad.tags ?? [])].join('、');
}

/** 記事のベクトル化対象テキスト */
export function contentEmbeddingText(c) {
  return [c.title, c.genre, c.body?.slice(0, 600) ?? ''].join('、');
}

// 記事ベクトルのキャッシュ。既存記事テーブルは読み取り専用参照(BD-001 6.1節)のため
// contentId+updatedAtをキーに再計算を省く(本番のS3 Vectors記事インデックス相当)。
const contentVecCache = new Map();

/** 記事の埋め込みベクトル(キャッシュ付き) */
export function contentVector(c) {
  const key = `${c.contentId}|${c.updatedAt ?? ''}`;
  let vec = contentVecCache.get(key);
  if (!vec) {
    vec = embed(contentEmbeddingText(c));
    contentVecCache.set(key, vec);
  }
  return vec;
}
