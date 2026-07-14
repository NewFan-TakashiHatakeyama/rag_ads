/**
 * RAG-Ads Lambda共有モジュール。
 * 各Lambdaはこの集約から import する(例: import { embed } from 'ragshared')。
 * CATEGORIESは分類用(llm)と広告カテゴリ用(validate)で衝突するため、集約では
 * CLASSIFY_CATEGORIES / AD_CATEGORIES に明示改名する。
 */
export * from './util.mjs';
export * from './config.mjs';
export * from './store.mjs';
export * from './embeddings.mjs'; // embed, embedInfo, adEmbeddingText, contentEmbeddingText
export * from './vector-index.mjs';
export {
  classifyQuestion, screenAd, generateLeads, validateLead, leadNgHit, NG_DICTIONARY,
  QUESTION_TYPES, CATEGORIES as CLASSIFY_CATEGORIES,
} from './llm.mjs';
export {
  validateAd, pickAdAttributes, QUESTION_TYPE_VALUES, CATEGORIES as AD_CATEGORIES,
} from './validate.mjs';
