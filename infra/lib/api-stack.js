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
  // θ_rel: Titan Embed v2の実測に基づく初期値(2026-07-14 dev検証)。
  // ローカルモック(bigram)では0.50だが、実埋め込みでは関連広告が0.32〜0.42・無関連が0.12未満に
  // 分布するため0.25を初期値とする。検証運用で継続チューニング(BD-001 11.2)。
  'theta_rel': '0.25',
  'max_slots': '3',
  'candidate_topk': '10',
  'max_per_advertiser': '1',
  'lead.min_chars': '20',
  'lead.max_chars': '60',
  'lead.model_id': 'jp.anthropic.claude-haiku-4-5-20251001-v1:0',
  'lead.enabled': 'true',
  'lead.fallback_text': 'ご質問に関連するサービスのご案内です。',
  'sampling.content_check': '0.10',
  // ---- 紐づけ候補(S-03・6.3.2)----
  // 広告↔記事の類似度は、配信で使う質問↔広告より低く出る(短い広告文 vs 長い記事本文のため)。
  // theta_rel(0.70)を流用すると候補ゼロになるので別パラメータで管理する。
  // dev実測: 無関連(住宅ローン広告×PR記事)0.58〜0.61 / 関連(AI広告×AI記事)0.63〜0.685 → 0.62
  'link.theta_rel': '0.62',
  // 記事の新しさによる足切り(既定30日=媒体のTTL保持期間と一致)
  'link.recency_days': '30',
  // 引用実績の加点(同程度の関連度なら引用の多い記事を上位に。関連度を覆さない小さめの値)
  'link.citation_weight': '0.05',
};

class ApiStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const n = props.naming;
    const { masterTable, placementsTable, dailyStatsTable, contentsTable } = props.dataStack;
    const siteTopUrl = props.siteTopUrl;
    // 広告システム自身のベクトル索引ARN。書込系はここに限定し、媒体の索引へは書けないようにする(11.4節の最小権限)
    const adVectorArns = [
      `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${props.vectorBucketName}`,
      `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${props.vectorBucketName}/index/${props.naming.s3.vectorIndex}`,
    ];

    // ---- 共有Lambdaレイヤー(ragshared: Bedrock/S3 Vectors/DynamoDB接続の共通モジュール) ----
    this.sharedLayer = new lambda.LayerVersion(this, 'SharedLayer', {
      layerVersionName: `rag-ads_shared-${n.env}`,
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'layers', 'shared')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'RAG-Ads 共有モジュール(埋め込み・ベクトル検索・LLM・検証)',
    });

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
    // θ_relは埋め込みプロバイダで分布が異なるため既定値を連動させる(誤配信防止)。
    //   bedrock/Titan: 関連0.32〜0.42・無関連<0.12 → 0.25
    //   gemini/3072  : 関連0.74〜0.90・無関連0.56〜0.65 → 0.70(2026-07-14 dev実測)
    const effectiveParams = { ...DEFAULT_PARAMS };
    if ((props.embedProvider ?? 'bedrock') === 'gemini') effectiveParams['theta_rel'] = '0.70';
    for (const [key, value] of Object.entries(effectiveParams)) {
      new ssm.StringParameter(this, `Param-${key.replace(/[^a-zA-Z0-9]/g, '-')}`, {
        parameterName: n.ssmParam(key),
        stringValue: value,
        description: `RAG-Ads 設定パラメータ(DD-001 表6): ${key}`,
      });
    }
    // 生成エンドポイントのサービス間APIキー(媒体NewFan-Financeが X-Api-Key で提示)。
    // デプロイ後に運用側で実値へ更新(SecureStringへの変更・ローテーション推奨)。
    new ssm.StringParameter(this, 'ServiceApiKey', {
      parameterName: n.ssmParam('service_api_key'),
      stringValue: props.serviceApiKey ?? 'CHANGE_ME_service_api_key',
      description: 'RAG-Ads 生成エンドポイントのサービス間APIキー(要ローテーション)',
    });

    // ---- Lambda共通 ----
    const lambdaDefaults = (fnKey, entryDir, extraEnv = {}) => ({
      functionName: n.lambdas[fnKey],
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', entryDir)),
      layers: [this.sharedLayer],
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
        [n.envVars.VECTOR_BUCKET]: props.vectorBucketName,
        [n.envVars.VECTOR_INDEX]: n.s3.vectorIndex,
        RAG_Ads_EMBED_MODEL_ID: props.embedModelId ?? 'amazon.titan-embed-text-v2:0',
        // 埋め込みプロバイダ(媒体Gemini空間へ整合する際に gemini/3072 へ切替。既定は bedrock/1024)
        RAG_Ads_EMBED_PROVIDER: props.embedProvider ?? 'bedrock',
        RAG_Ads_EMBED_DIMENSION: String(props.embedDimension ?? 1024),
        ...(props.geminiApiKey ? { RAG_Ads_GEMINI_API_KEY: props.geminiApiKey } : {}),
        RAG_Ads_ENV: n.env,
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

    // 広告生成エンドポイント(サービス方式。DD-001 3.2 G-1〜G-10)。媒体の回答生成が呼ぶ
    this.generateAdsFn = new lambda.Function(this, 'GenerateAdsFn', {
      ...lambdaDefaults('generateAds', 'generate-ads', contentsTable ? { [n.envVars.TABLE_CONTENTS]: contentsTable.tableName } : {}),
      timeout: Duration.seconds(29),
      memorySize: 512,
    });
    masterTable.grantReadData(this.generateAdsFn);
    placementsTable.grantReadWriteData(this.generateAdsFn);
    dailyStatsTable.grantReadWriteData(this.generateAdsFn);
    if (contentsTable) contentsTable.grantReadData(this.generateAdsFn);
    this.generateAdsFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'SsmRead', actions: ['ssm:GetParametersByPath', 'ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${n.ssmPrefix}/*`],
    }));
    this.generateAdsFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'BedrockInvoke', actions: ['bedrock:InvokeModel'], resources: ['*'], // 埋め込み+リード文生成
    }));
    this.generateAdsFn.addToRolePolicy(new iam.PolicyStatement({
      // 候補検索(QueryVectorsはGetVectorsも要求する)。広告索引の読取のみ
      sid: 'VectorQuery',
      actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors', 's3vectors:GetIndex'],
      resources: adVectorArns,
    }));

    // 広告管理API(6.3節)。広告CRUD・審査・紐づけ・レポート+ベクトル同期・スクリーニング
    this.adminApiFn = new lambda.Function(this, 'AdminApiFn', {
      ...lambdaDefaults('adminApi', 'admin-api'),
      timeout: Duration.seconds(29),
      memorySize: 512,
    });
    masterTable.grantReadWriteData(this.adminApiFn);
    placementsTable.grantReadData(this.adminApiFn);
    dailyStatsTable.grantReadData(this.adminApiFn);
    // 記事テーブル(6.3.3節): 読み取りのみ付与(書込権限は付与しない。11.4節の最小権限)
    if (contentsTable) {
      contentsTable.grantReadData(this.adminApiFn);
      this.adminApiFn.addEnvironment(n.envVars.TABLE_CONTENTS, contentsTable.tableName);
    }
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
      sid: 'AdVectorIndexSync', // 承認時Put/停止時Delete(5.4節)。書込は広告システム自身の索引のみ
      actions: [
        's3vectors:PutVectors', 's3vectors:DeleteVectors',
        's3vectors:QueryVectors', 's3vectors:GetVectors', 's3vectors:GetIndex',
      ],
      resources: adVectorArns,
    }));
    // 媒体の記事ベクトル索引(6.3.2): 広告ベクトルでANN検索して紐づけ候補を出す。
    // 記事は媒体側で埋め込み済み(決定A-1で同一Gemini空間)のため、記事件数に依存せず候補を取得できる。
    // 【重要】媒体の記事・ベクトルは実サービスのデータ。広告システムからは読取専用とし、
    //        書込系(PutVectors/DeleteVectors)はIAMで付与しない(誤操作を権限で防ぐ)。
    if (props.contentVectorBucket && props.contentVectorIndex) {
      this.adminApiFn.addEnvironment('RAG_Ads_CONTENT_VECTOR_BUCKET', props.contentVectorBucket);
      this.adminApiFn.addEnvironment('RAG_Ads_CONTENT_VECTOR_INDEX', props.contentVectorIndex);
      this.adminApiFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MediaVectorReadOnly',
        actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors', 's3vectors:GetIndex'],
        resources: [
          `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${props.contentVectorBucket}`,
          `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${props.contentVectorBucket}/index/${props.contentVectorIndex}`,
        ],
      }));
    }
    // 媒体の記事テーブル(6.3.3): コンテンツ詳細の本文取得。読み取りのみ(11.4節の最小権限)
    if (props.mediaContentTable) {
      this.adminApiFn.addEnvironment('RAG_Ads_MEDIA_CONTENT_TABLE', props.mediaContentTable);
      this.adminApiFn.addToRolePolicy(new iam.PolicyStatement({
        sid: 'MediaContentRead',
        actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem'],
        resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/${props.mediaContentTable}`],
      }));
    }

    // ---- HTTP API(6.1節: 管理系=Cognito JWT、配信系=公開) ----
    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `rag-ads_api-${n.env}`,
      corsPreflight: {
        allowOrigins: props.corsOrigins ?? ['*'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ['Authorization', 'Content-Type', 'X-Api-Key'],
      },
    });
    const jwtAuthorizer = new authorizers.HttpJwtAuthorizer('JwtAuth',
      `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
      { jwtAudience: [this.userPoolClient.userPoolClientId] });

    const pageAdsIntegration = new integrations.HttpLambdaIntegration('PageAdsInt', this.pageAdsFn);
    const clickIntegration = new integrations.HttpLambdaIntegration('ClickInt', this.clickFn);
    const generateIntegration = new integrations.HttpLambdaIntegration('GenerateInt', this.generateAdsFn);
    const adminIntegration = new integrations.HttpLambdaIntegration('AdminInt', this.adminApiFn);

    // 配信系(公開)。生成はサービス間APIキー認証(Lambda内)
    this.httpApi.addRoutes({ path: '/v1/pages/{pageId}/ads', methods: [apigwv2.HttpMethod.GET], integration: pageAdsIntegration });
    this.httpApi.addRoutes({ path: '/r/{pageId}/{slot}', methods: [apigwv2.HttpMethod.GET], integration: clickIntegration });
    this.httpApi.addRoutes({ path: '/v1/pages/{pageId}/generate-ads', methods: [apigwv2.HttpMethod.POST], integration: generateIntegration });

    // 管理系(Cognito JWT必須。7.1節のエンドポイント一式)。
    // 注意: ANYはOPTIONSも捕捉しオーソライザがプリフライトを401にするため、実メソッドのみ列挙し
    // OPTIONS(CORSプリフライト)は自動ハンドラに委ねる(ブラウザからのCORS通信を成立させる)。
    const M = apigwv2.HttpMethod;
    const adminRoutes = [
      ['/v1/ads', [M.GET, M.POST]],
      ['/v1/ads/{adId}', [M.GET, M.PUT]],
      ['/v1/ads/{adId}/status', [M.PATCH]],
      ['/v1/ads/{adId}/link-candidates', [M.GET]],
      ['/v1/ads/{adId}/links/{contentId}', [M.PUT, M.DELETE]],
      ['/v1/reports/ads/{adId}', [M.GET]],
      ['/v1/contents/{contentId}', [M.GET]],
      ['/v1/params', [M.GET, M.PUT]],
      ['/v1/batch/daily-agg', [M.POST]],
    ];
    for (const [path, methods] of adminRoutes) {
      this.httpApi.addRoutes({ path, methods, integration: adminIntegration, authorizer: jwtAuthorizer });
    }

    new CfnOutput(this, 'ApiEndpoint', { value: this.httpApi.apiEndpoint });
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
  }
}

module.exports = { ApiStack, DEFAULT_PARAMS };
