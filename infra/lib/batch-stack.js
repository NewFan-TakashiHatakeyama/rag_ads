/**
 * RAG-Ads-Batch-Stack (DD-001 13.1)
 * 日次集計Lambda(9.1節: 毎日04:00 JST)+DLQ再処理Lambda(9.2節)+
 * SNSトピック(開発/課金)+CloudWatchアラーム(表12)+ダッシュボード(10.3節)。
 */
'use strict';
const path = require('node:path');
const { Stack, Duration, CfnOutput } = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const events = require('aws-cdk-lib/aws-events');
const targets = require('aws-cdk-lib/aws-events-targets');
const sns = require('aws-cdk-lib/aws-sns');
const cloudwatch = require('aws-cdk-lib/aws-cloudwatch');
const cwActions = require('aws-cdk-lib/aws-cloudwatch-actions');
const lambdaEventSources = require('aws-cdk-lib/aws-lambda-event-sources');
const logs = require('aws-cdk-lib/aws-logs');
const iam = require('aws-cdk-lib/aws-iam');

class BatchStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const n = props.naming;
    const { masterTable, placementsTable, dailyStatsTable, vectorSyncDlq } = props.dataStack;

    // 共有レイヤーは各スタックで独立に作成する(クロススタックexport参照のデッドロックを避けるため)。
    // アセットは同一(infra/lambda/layers/shared)。
    const sharedLayer = new lambda.LayerVersion(this, 'SharedLayer', {
      layerVersionName: `rag-ads_shared-batch-${n.env}`,
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'layers', 'shared')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_22_X],
      compatibleArchitectures: [lambda.Architecture.ARM_64],
      description: 'RAG-Ads 共有モジュール(Batchスタック用)',
    });

    // ---- SNSトピック(表16) ----
    this.alertsTopic = new sns.Topic(this, 'AlertsTopic', {
      topicName: n.sns.alerts,
      displayName: 'RAG-Ads 開発向けアラート',
    });
    this.billingAlertsTopic = new sns.Topic(this, 'BillingAlertsTopic', {
      topicName: n.sns.billingAlerts,
      displayName: 'RAG-Ads 課金・運用アラート',
    });

    // ---- 日次集計Lambda(9.1節) ----
    this.dailyAggFn = new lambda.Function(this, 'DailyAggFn', {
      functionName: n.lambdas.dailyAgg,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'daily-agg')),
      memorySize: 512,
      timeout: Duration.seconds(300), // 実行時間はPoC規模で数十秒・タイムアウト300秒(9.1節)
      logGroup: new logs.LogGroup(this, 'DailyAggLogs', {
        logGroupName: `/aws/lambda/${n.lambdas.dailyAgg}`,
        retention: logs.RetentionDays.THREE_MONTHS,
      }),
      layers: [sharedLayer], // 共有ライブラリ(埋め込み・ベクトル同期・ストア)。当スタック独自
      environment: {
        [n.envVars.TABLE_MASTER]: masterTable.tableName,
        [n.envVars.TABLE_PLACEMENTS]: placementsTable.tableName,
        [n.envVars.TABLE_DAILY_STATS]: dailyStatsTable.tableName,
        [n.envVars.ALERT_TOPIC_ARN]: this.alertsTopic.topicArn,
        [n.envVars.METRICS_NAMESPACE]: n.metricsNamespace,
        [n.envVars.VECTOR_BUCKET]: props.vectorBucketName,
        [n.envVars.VECTOR_INDEX]: n.s3.vectorIndex,
        [n.envVars.SSM_PREFIX]: n.ssmPrefix,
        RAG_Ads_EMBED_MODEL_ID: props.embedModelId ?? 'amazon.titan-embed-text-v2:0',
        RAG_Ads_EMBED_PROVIDER: props.embedProvider ?? 'bedrock',
        RAG_Ads_EMBED_DIMENSION: String(props.embedDimension ?? 1024),
        ...(props.geminiApiKey ? { RAG_Ads_GEMINI_API_KEY: props.geminiApiKey } : {}),
        RAG_Ads_ENV: n.env,
      },
    });
    masterTable.grantReadWriteData(this.dailyAggFn);
    placementsTable.grantReadData(this.dailyAggFn);
    dailyStatsTable.grantReadWriteData(this.dailyAggFn);
    this.alertsTopic.grantPublish(this.dailyAggFn);
    // 状態自動遷移のベクトル同期(9.2節): 配信開始でPut(要Bedrock埋め込み)、期限切れでDelete
    this.dailyAggFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'VectorSync', actions: ['s3vectors:PutVectors', 's3vectors:DeleteVectors', 's3vectors:GetIndex'], resources: ['*'],
    }));
    this.dailyAggFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'BedrockEmbed', actions: ['bedrock:InvokeModel'], resources: ['*'],
    }));
    this.dailyAggFn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'SsmRead', actions: ['ssm:GetParametersByPath', 'ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${n.ssmPrefix}/*`],
    }));

    // EventBridgeスケジュール: 毎日04:00 JST = 19:00 UTC(前日)
    new events.Rule(this, 'DailyAggSchedule', {
      ruleName: n.events.dailyAggSchedule,
      schedule: events.Schedule.cron({ minute: '0', hour: '19' }),
      targets: [new targets.LambdaFunction(this.dailyAggFn, { retryAttempts: 2 })],
      description: 'RAG-Ads 日次集計(毎日04:00 JST。DD-001 9.1節)',
    });

    // ---- ベクトル同期DLQ再処理Lambda(9.2節: 5分間隔の再試行) ----
    this.vectorSyncRetryFn = new lambda.Function(this, 'VectorSyncRetryFn', {
      functionName: n.lambdas.vectorSyncRetry,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'vector-sync-retry')),
      memorySize: 256,
      timeout: Duration.seconds(60),
      logGroup: new logs.LogGroup(this, 'VectorSyncRetryLogs', {
        logGroupName: `/aws/lambda/${n.lambdas.vectorSyncRetry}`,
        retention: logs.RetentionDays.THREE_MONTHS,
      }),
    });
    this.vectorSyncRetryFn.addEventSource(new lambdaEventSources.SqsEventSource(vectorSyncDlq, {
      batchSize: 10,
      maxBatchingWindow: Duration.minutes(5),
    }));

    // ---- アラーム(表12の実装可能サブセット) ----
    const alarmAction = new cwActions.SnsAction(this.alertsTopic);

    // PageAdsLatency: 広告取得API P95 > 300ms(15分)
    new cloudwatch.Alarm(this, 'PageAdsLatencyAlarm', {
      alarmName: n.alarm('PageAdsLatency'),
      metric: props.pageAdsFn.metricDuration({ statistic: 'p95', period: Duration.minutes(15) }),
      threshold: 300,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: '広告取得APIレイテンシ P95>300ms(DD-001 表12)',
    }).addAlarmAction(alarmAction);

    // VectorSyncDLQDepth: 滞留 >= 1(10分継続)
    new cloudwatch.Alarm(this, 'VectorSyncDlqDepthAlarm', {
      alarmName: n.alarm('VectorSyncDLQDepth'),
      metric: vectorSyncDlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'ベクトル同期DLQ滞留(DD-001 表12)',
    }).addAlarmAction(alarmAction);

    // Lambdaエラー(click / admin-api / daily-agg)
    for (const [key, fn] of [
      ['ClickErrors', props.clickFn],
      ['AdminApiErrors', props.adminApiFn],
      ['DailyAggErrors', this.dailyAggFn],
    ]) {
      new cloudwatch.Alarm(this, `${key}Alarm`, {
        alarmName: n.alarm(key),
        metric: fn.metricErrors({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(alarmAction);
    }

    // DailySpend(カスタムメトリクス。媒体側パイプライン組込後に発行される): 監視のみ先行定義
    const dailySpend = new cloudwatch.Metric({
      namespace: n.metricsNamespace,
      metricName: 'DailySpend',
      period: Duration.hours(1),
      statistic: 'Maximum',
    });

    // ---- ダッシュボード(10.3節) ----
    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: n.dashboard,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: '広告取得API レイテンシ(P95)/呼出数',
        left: [props.pageAdsFn.metricDuration({ statistic: 'p95' })],
        right: [props.pageAdsFn.metricInvocations()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'クリック計測 呼出数/エラー',
        left: [props.clickFn.metricInvocations()],
        right: [props.clickFn.metricErrors()],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'DailySpend(当日課金額・カスタムメトリクス)',
        left: [dailySpend],
        width: 12,
      }),
      new cloudwatch.GraphWidget({
        title: 'ベクトル同期DLQ滞留',
        left: [props.dataStack.vectorSyncDlq.metricApproximateNumberOfMessagesVisible()],
        width: 12,
      }),
    );

    new CfnOutput(this, 'AlertsTopicArn', { value: this.alertsTopic.topicArn });
    new CfnOutput(this, 'DashboardName', { value: n.dashboard });
  }
}

module.exports = { BatchStack };
