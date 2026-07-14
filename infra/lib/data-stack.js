/**
 * RAG-Ads-Data-Stack (DD-001 13.1)
 * DynamoDB 3テーブル(5章のキー設計・GSI・TTL)+ベクトル同期DLQ(SQS)。
 * S3 Vectorsインデックスは既存ベクトルバケット内に作成するため、CloudFormation外の
 * セットアップスクリプト(scripts/create-vector-index.sh)で管理する(5.4節)。
 */
'use strict';
const { Stack, RemovalPolicy, Duration, CfnOutput } = require('aws-cdk-lib');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const sqs = require('aws-cdk-lib/aws-sqs');

class DataStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const n = props.naming;
    // PoC期間中のdevは破棄可能、prodは保持(課金整合性のためPlacementは削除しない: 13.3)
    const removal = n.env === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    // RagAds(広告マスタ・記事紐づけ): PK=AD#{adId}, SK=META|LINK#{contentId} (5.1節)
    this.masterTable = new dynamodb.Table(this, 'MasterTable', {
      tableName: n.tables.master,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removal,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: n.env === 'prod' },
    });
    // GSI1: ステータス別一覧 (BD-001 6.2.1)
    this.masterTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });
    // GSI2: 記事→広告の逆引き(競合広告数の算出)
    this.masterTable.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
    });

    // RagAdPlacements(配置=引用記録): PK=PAGE#{pageId}, SK=SLOT#{n}、TTL13ヶ月 (5.2節)
    this.placementsTable = new dynamodb.Table(this, 'PlacementsTable', {
      tableName: n.tables.placements,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: n.env === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: n.env === 'prod' },
    });
    // GSI1: 広告別×期間の集計走査(日次バッチ・明細参照)
    this.placementsTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
    });

    // RagAdDailyStats(日次統計・予算カウンタ): PK=AD#{adId}, SK=DATE#{yyyy-MM-dd} (5.3節)
    this.dailyStatsTable = new dynamodb.Table(this, 'DailyStatsTable', {
      tableName: n.tables.dailyStats,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: removal,
    });

    // ベクトル同期DLQ(9.2節: Put/Delete失敗の退避先)
    // 可視性タイムアウトは再処理Lambda(timeout 60s)以上が必須。AWS推奨のfunction timeout×6を採用
    this.vectorSyncDlq = new sqs.Queue(this, 'VectorSyncDlq', {
      queueName: n.sqs.vectorSyncDlq,
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.seconds(360),
      enforceSSL: true,
    });

    new CfnOutput(this, 'MasterTableName', { value: this.masterTable.tableName });
    new CfnOutput(this, 'PlacementsTableName', { value: this.placementsTable.tableName });
    new CfnOutput(this, 'DailyStatsTableName', { value: this.dailyStatsTable.tableName });
    new CfnOutput(this, 'VectorSyncDlqUrl', { value: this.vectorSyncDlq.queueUrl });
  }
}

module.exports = { DataStack };
