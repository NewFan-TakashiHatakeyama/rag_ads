#!/usr/bin/env node
/**
 * RAG-Ads CDKアプリ(DD-001 13.1)。
 * デプロイ順序: Data → Api → Batch → Front(依存関係で強制)。
 * 例: npx cdk deploy --all -c env=dev
 */
'use strict';
const cdk = require('aws-cdk-lib');
const { naming } = require('../lib/naming');
const { DataStack } = require('../lib/data-stack');
const { ApiStack } = require('../lib/api-stack');
const { BatchStack } = require('../lib/batch-stack');
const { FrontStack } = require('../lib/front-stack');

const app = new cdk.App();
const env = app.node.tryGetContext('env') ?? 'dev';
const n = naming(env);

// 環境依存の外部パラメータ(cdk.jsonのcontextまたは -c で上書き)
const siteTopUrl = app.node.tryGetContext('siteTopUrl') ?? 'https://finance.newfan.co.jp/';
const vectorBucketName = app.node.tryGetContext('vectorBucketName') ?? `rag-ads-vectors-${env}`;
const corsOrigins = app.node.tryGetContext('corsOrigins') ?? ['*'];
const embedModelId = app.node.tryGetContext('embedModelId') ?? 'amazon.titan-embed-text-v2:0';
// 埋め込みプロバイダ整合(媒体Gemini空間へ揃える場合: -c embedProvider=gemini -c embedDimension=3072
//  -c geminiApiKey=... とし、S3 Vectorsインデックスも3072で作り直す)。既定は自立稼働のbedrock/1024。
const embedProvider = app.node.tryGetContext('embedProvider') ?? 'bedrock';
const embedDimension = Number(app.node.tryGetContext('embedDimension') ?? 1024);
const geminiApiKey = app.node.tryGetContext('geminiApiKey') ?? process.env.RAG_ADS_GEMINI_API_KEY ?? '';

const awsEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const dataStack = new DataStack(app, n.stack('Data'), { env: awsEnv, naming: n });
const serviceApiKey = app.node.tryGetContext('serviceApiKey') ?? process.env.RAG_ADS_SERVICE_API_KEY ?? undefined;
const apiStack = new ApiStack(app, n.stack('Api'), {
  env: awsEnv, naming: n, dataStack, siteTopUrl, vectorBucketName, corsOrigins,
  embedModelId, embedProvider, embedDimension, geminiApiKey, serviceApiKey,
});
apiStack.addDependency(dataStack);
const batchStack = new BatchStack(app, n.stack('Batch'), {
  env: awsEnv, naming: n, dataStack,
  pageAdsFn: apiStack.pageAdsFn, clickFn: apiStack.clickFn, adminApiFn: apiStack.adminApiFn,
  vectorBucketName, embedModelId, embedProvider, embedDimension, geminiApiKey,
});
batchStack.addDependency(apiStack);
const frontStack = new FrontStack(app, n.stack('Front'), {
  env: awsEnv, naming: n,
  apiEndpoint: apiStack.httpApi.apiEndpoint,
  userPoolId: apiStack.userPool.userPoolId,
  userPoolClientId: apiStack.userPoolClient.userPoolClientId,
});
frontStack.addDependency(batchStack);
frontStack.addDependency(apiStack);

// 共通タグ(14.2節: Project/Env/ManagedBy)
for (const [k, v] of Object.entries(n.tags)) {
  cdk.Tags.of(app).add(k, v);
}
