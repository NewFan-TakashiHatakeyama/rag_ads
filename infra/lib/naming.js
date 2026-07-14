/**
 * リソース命名ヘルパー(NF-RAGAD-DD-001 14章 表15・表16)。
 * 全リソースの物理名はこのヘルパー経由で参照する。ヘルパー外での直書きは禁止(14.4節)。
 *
 * 変種:
 *  - rag_ads_XX  : DynamoDBテーブル、SSMパラメータ階層
 *  - rag-ads_XX  : Lambda、SQS、SNS、EventBridge、Cognito
 *  - RAG-Ads_XX  : IAMロール、CloudWatchダッシュボード・アラーム
 *  - RAG_Ads_XX  : 環境変数、カスタムメトリクス名前空間
 *  - 14.3例外    : S3系は小文字ハイフンのみ(rag-ads-XX-{env})、スタック名はRAG-Ads-XX形式
 */
'use strict';

const ENVS = ['dev', 'prod'];

function naming(env) {
  if (!ENVS.includes(env)) throw new Error(`env は dev|prod を指定してください: ${env}`);
  return {
    env,

    // DynamoDB(rag_ads_XX)
    tables: {
      master: `rag_ads_master_${env}`,
      placements: `rag_ads_placements_${env}`,
      dailyStats: `rag_ads_daily_stats_${env}`,
    },

    // Lambda(rag-ads_XX)
    lambdas: {
      pageAds: `rag-ads_page-ads-${env}`,
      click: `rag-ads_click-${env}`,
      generateAds: `rag-ads_generate-ads-${env}`,
      adminApi: `rag-ads_admin-api-${env}`,
      dailyAgg: `rag-ads_daily-agg-${env}`,
      vectorSyncRetry: `rag-ads_vector-sync-retry-${env}`,
    },

    // SQS / SNS / EventBridge / Cognito(rag-ads_XX)
    sqs: { vectorSyncDlq: `rag-ads_vector-sync-dlq-${env}` },
    sns: {
      alerts: `rag-ads_alerts-${env}`,
      billingAlerts: `rag-ads_billing-alerts-${env}`,
    },
    events: { dailyAggSchedule: `rag-ads_daily-agg-schedule-${env}` },
    cognito: { userPool: `rag-ads_userpool-${env}` },

    // SSMパラメータ階層(表6)
    ssmPrefix: `/rag_ads/${env}`,
    ssmParam: (key) => `/rag_ads/${env}/${key}`,

    // IAM / CloudWatch(RAG-Ads_XX)
    role: (fn) => `RAG-Ads_${fn}-role-${env}`,
    dashboard: `RAG-Ads_Dashboard-${env}`,
    alarm: (metric) => `RAG-Ads_${metric}-${env}`,

    // CloudFormation/CDKスタック(14.3例外: アンダースコア不可)
    stack: (xx) => `RAG-Ads-${xx}-Stack-${env}`,

    // S3系(14.3例外: 小文字・ハイフンのみ)。
    // SPAバケットはS3のグローバル一意制約のためアカウントIDを付加する(14.3の制約置換の追加適用)
    s3: {
      adminBucket: (accountId) => `rag-ads-admin-${env}-${accountId}`,
      vectorIndex: `rag-ads-index-${env}`,
    },

    // 環境変数・メトリクス(RAG_Ads_XX)
    envVars: {
      TABLE_MASTER: 'RAG_Ads_TABLE_MASTER',
      TABLE_PLACEMENTS: 'RAG_Ads_TABLE_PLACEMENTS',
      TABLE_DAILY_STATS: 'RAG_Ads_TABLE_DAILY_STATS',
      TABLE_CONTENTS: 'RAG_Ads_TABLE_CONTENTS',
      SSM_PREFIX: 'RAG_Ads_SSM_PREFIX',
      SITE_TOP_URL: 'RAG_Ads_SITE_TOP_URL',
      VECTOR_BUCKET: 'RAG_Ads_VECTOR_BUCKET',
      VECTOR_INDEX: 'RAG_Ads_VECTOR_INDEX',
      METRICS_NAMESPACE: 'RAG_Ads_METRICS_NAMESPACE',
      ALERT_TOPIC_ARN: 'RAG_Ads_ALERT_TOPIC_ARN',
    },
    metricsNamespace: 'RAG_Ads',

    // 共通タグ(14.2節)
    tags: { Project: 'RAG-Ads', Env: env, ManagedBy: 'cdk' },
  };
}

module.exports = { naming };
