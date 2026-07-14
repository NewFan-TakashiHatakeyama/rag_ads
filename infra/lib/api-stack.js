/**
 * RAG-Ads-Api-Stack (DD-001 13.1)
 * Lambda(page-ads / click / admin-api)、HTTP API(配信系=公開・管理系=Cognito JWT)、
 * Cognitoユーザープール(advertiser/adminグループ)、SSMパラメータ(表6)。
 * フィーチャーフラグ enabled は段階0(13.2)に従い false で作成する。
 */
'use strict';
const path = require('node:path');
const { Stack, Duration, CfnOutput } = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2');
const integrations = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const authorizers = require('aws-cdk-lib/aws-apigatewayv2-authorizers');
const cognito = require('aws-cdk-lib/aws-cognito');
const ssm = require('aws-cdk-lib/aws-ssm');
const iam = require('aws-cdk-lib/aws-iam');
const logs = require('aws-cdk-lib/aws-logs');

/** 設定パラメータ初期値(DD-001 表6)。enabledのみ段階0のためfalse */
const DEFAULT_PARAMS = {
  'enabled': 'false',
  'weights.rel': '0.6',
  'weights.bid': '0.2',
  'weights.link': '0.2',
  'theta_rel': '0.50',
  'max_slots': '3',
  'candidate_topk': '10',
  'max_per_advertiser': '1',
  'lead.min_chars': '20',
  'lead.max_chars': '60',
  'lead.model_id': 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'lead.enabled': 'true',
  'lead.fallback_text': 'ご質問に関連するサービスのご案内です。',
  'sampling.content_check': '0.10',
};

class ApiStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const n = props.naming;
    const { masterTable, placementsTable, dailyStatsTable } = props.dataStack;
    const siteTopUrl = props.siteTopUrl;

    // ---- Cognito(11.1節: ユーザープール1面+advertiser/adminグループ) ----
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: n.cognito.userPool,
      selfSignUpEnabled: false, // 利用者は社内限定(BD-001 2.4)
      signInAliases: { email: true },
      passwordPolicy: { minLength: 10, requireLowercase: true, requireDigits: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    });
    this.userPoolClient = this.userPool.addClient('AdminSpaClient', {
      userPoolClientName: `rag-ads_admin-spa-${n.env}`,
      authFlows: { userSrp: true, userPassword: true },
      idTokenValidity: Duration.hours(8),
      accessTokenValidity: Duration.hours(1),
    });
    for (const [groupName, description] of [
      ['advertiser', '広告主(自広告の管理)'],
      ['admin', '管理者・審査者(全広告+審査操作)'],
    ]) {
      new cognito.CfnUserPoolGroup(this, `Group-${groupName}`, {
        userPoolId: this.userPool.userPoolId,
        groupName,
        description,
      });
    }

    // ---- SSMパラメータ(表6。/rag_ads/{env}/…) ----
    for (const [key, value] of Object.entries(DEFAULT_PARAMS)) {
      new ssm.StringParameter(this, `Param-${key.replace(/[^a-zA-Z0-9]/g, '-')}`, {
        parameterName: n.ssmParam(key),
        stringValue: value,
        description: `RAG-Ads 設定パラメータ(DD-001 表6): ${key}`,
      });
    }

    // ---- Lambda共通 ----
    const lambdaDefaults = (fnKey, entryDir, extraEnv = {}) => ({
      functionName: n.lambdas[fnKey],
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', entryDir)),
      memorySize: 256,
      timeout: Duration.seconds(10),
      logGroup: new logs.LogGroup(this, `${fnKey}Logs`, {
        logGroupName: `/aws/lambda/${n.lambdas[fnKey]}`,
        retention: logs.RetentionDays.THREE_MONTHS,
      }),
      environment: {
        [n.envVars.TABLE_MASTER]: masterTable.tableName,
        [n.envVars.TABLE_PLACEMENTS]: placementsTable.tableName,
        [n.envVars.TABLE_DAILY_STATS]: dailyStatsTable.tableName,
        [n.envVars.SSM_PREFIX]: n.ssmPrefix,
        [n.envVars.SITE_TOP_URL]: siteTopUrl,
        [n.envVars.METRICS_NAMESPACE]: n.metricsNamespace,
        ...extraEnv,
      },
    });

    // 広告取得API(3.3節: 有効性判定+表示加算。P95 300ms目標)
    this.pageAdsFn = new lambda.Function(this, 'PageAdsFn', lambdaDefaults('pageAds', 'page-ads'));
    placementsTable.grantReadWriteData(this.pageAdsFn);
    masterTable.grantReadData(this.pageAdsFn);
    dailyStatsTable.grantWriteData(this.pageAdsFn);

    // クリック計測(6.2.3節: 最小権限=Placements/DailyStatsのUpdateItemのみ。11.4節)
    this.clickFn = new lambda.Function(this, 'ClickFn', lambdaDefaults('click', 'click'));
    placementsTable.grantReadWriteData(this.clickFn);
    dailyStatsTable.grantWriteData(this.clickFn);

    // 広告管理API(6.3節。ビジネスロジックはPhase 1.5でローカル実装から移植)
    this.adminApiFn = new lambda.Function(this, 'AdminApiFn', {
      ...lambdaDefaults('adminApi', 'admin-api', {
        [n.envVars.VECTOR_BUCKET]: props.vectorBucketName,
        [n.envVars.VECTOR_INDEX]: n.s3.vectorIndex,
      }),
      timeout: Duration.seconds(29),
      memorySize: 512,
    });
    masterTable.grantReadWriteData(this.adminApiFn);
    placementsTable.grantReadData(this.adminApiFn);
    dailyStatsTable.grantReadData(this.adminApiFn);
    this.adminApiFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'SsmParams',
      actions: ['ssm:GetParametersByPath', 'ssm:GetParameter', 'ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${n.ssmPrefix}/*`],
    }));
    this.adminApiFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke', // スクリーニング・リード文生成(7章)
      actions: ['bedrock:InvokeModel'],
      resources: ['*'],
    }));
    this.adminApiFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'VectorIndexSync', // 承認時Put/停止時Delete(5.4節)
      actions: ['s3vectors:PutVectors', 's3vectors:DeleteVectors', 's3vectors:QueryVectors', 's3vectors:GetIndex'],
      resources: ['*'],
    }));

    // ---- HTTP API(6.1節: 管理系=Cognito JWT、配信系=公開) ----
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `rag-ads_api-${n.env}`,
      corsPreflight: {
        allowOrigins: props.corsOrigins ?? ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    });
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer('JwtAuth',
      `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
      { jwtAudience: [this.userPoolClient.userPoolClientId] });

    const pageAdsIntegration = new integrations.HttpLambdaIntegration('PageAdsInt', this.pageAdsFn);
    const clickIntegration = new integrations.HttpLambdaIntegration('ClickInt', this.clickFn);
    const adminIntegration = new integrations.HttpLambdaIntegration('AdminInt', this.adminApiFn);

    // 配信系(公開)
    this.httpApi.addRoutes({ path: '/v1/pages/{pageId}/ads', methods: [apigwv2.HttpMethod.GET], integration: pageAdsIntegration });
    this.httpApi.addRoutes({ path: '/r/{pageId}/{slot}', methods: [apigwv2.HttpMethod.GET], integration: clickIntegration });

    // 管理系(Cognito JWT必須。7.1節のエンドポイント一式)
    for (const p of [
      '/v1/ads', '/v1/ads/{adId}', '/v1/ads/{adId}/status',
      '/v1/ads/{adId}/link-candidates', '/v1/ads/{adId}/links/{contentId}',
      '/v1/reports/ads/{adId}', '/v1/contents/{contentId}',
      '/v1/params', '/v1/batch/daily-agg',
    ]) {
      this.httpApi.addRoutes({
        path: p,
        methods: [apigwv2.HttpMethod.ANY],
        integration: adminIntegration,
        authorizer: jwtAuthorizer,
      });
    }

    new CfnOutput(this, 'ApiEndpoint', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}

module.exports = { ApiStack, DEFAULT_PARAMS };
