/**
 * RAG-Ads-Front-Stack (DD-001 13.1)
 * 広告管理コンソールSPAの配信基盤(S3+CloudFront・OAC)。
 * AdSlotBlockは既存Next.jsリポジトリへの組み込みのため本スタック対象外(13.1節)。
 */
'use strict';
const path = require('node:path');
const { Stack, RemovalPolicy, Duration, CfnOutput } = require('aws-cdk-lib');
const s3 = require('aws-cdk-lib/aws-s3');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const s3deploy = require('aws-cdk-lib/aws-s3-deployment');

class FrontStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const n = props.naming;

    this.adminBucket = new s3.Bucket(this, 'AdminBucket', {
      bucketName: n.s3.adminBucket(this.account),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: n.env === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: n.env !== 'prod',
    });

    this.distribution = new cloudfront.Distribution(this, 'AdminDistribution', {
      comment: `RAG-Ads 管理コンソール(${n.env})`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.adminBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        // SPAのためルート直打ちはindex.htmlへフォールバック
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(10) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(10) },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200, // 日本を含むリージョン
    });

    // 現行SPA資産のデプロイ(Cognito認証への接続はadmin-api移植と同時に更新予定)
    new s3deploy.BucketDeployment(this, 'DeployAdminSpa', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'web', 'admin'))],
      destinationBucket: this.adminBucket,
      distribution: this.distribution,
      distributionPaths: ['/*'],
    });

    new CfnOutput(this, 'AdminConsoleUrl', { value: `https://${this.distribution.distributionDomainName}` });
  }
}

module.exports = { FrontStack };
