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

const awsEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const dataStack = new DataStack(app, n.stack('Data'), { env: awsEnv, naming: n });
const apiStack = new ApiStack(app, n.stack('Api'), {
  env: awsEnv, naming: n, dataStack, siteTopUrl, vectorBucketName, corsOrigins,
});
apiStack.addDependency(dataStack);
const batchStack = new BatchStack(app, n.stack('Batch'), {
  env: awsEnv, naming: n, dataStack,
  pageAdsFn: apiStack.pageAdsFn, clickFn: apiStack.clickFn, adminApiFn: apiStack.adminApiFn,
});
batchStack.addDependency(apiStack);
const frontStack = new FrontStack(app, n.stack('Front'), { env: awsEnv, naming: n });
frontStack.addDependency(batchStack);

// 共通タグ(14.2節: Project/Env/ManagedBy)
for (const [k, v] of Object.entries(n.tags)) {
  cdk.Tags.of(app).add(k, v);
}
