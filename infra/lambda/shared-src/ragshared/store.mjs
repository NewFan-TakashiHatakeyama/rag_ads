/**
 * DynamoDBアクセス層(DD-001 5章)。ローカルPoC server/store.js の条件式セマンティクスを
 * 実DynamoDBのConditionExpression/TransactWriteItems/UpdateItemにマップする。
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand,
  QueryCommand, ScanCommand, BatchGetCommand, TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';

export const TABLES = {
  master: process.env.RAG_Ads_TABLE_MASTER,
  placements: process.env.RAG_Ads_TABLE_PLACEMENTS,
  stats: process.env.RAG_Ads_TABLE_DAILY_STATS,
};

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export class ConditionalCheckFailed extends Error {
  constructor(msg = 'ConditionalCheckFailed') { super(msg); this.name = 'ConditionalCheckFailed'; }
}

export async function getItem(table, key) {
  const r = await ddb.send(new GetCommand({ TableName: table, Key: key }));
  return r.Item ?? null;
}

export async function putItem(table, item, { conditionNotExists = false } = {}) {
  try {
    await ddb.send(new PutCommand({
      TableName: table, Item: item,
      ...(conditionNotExists ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
    }));
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw new ConditionalCheckFailed();
    throw e;
  }
}

export async function deleteItem(table, key) {
  await ddb.send(new DeleteCommand({ TableName: table, Key: key }));
}

/** PK=pk (SK昇順)。skPrefix指定でbegins_with(SK)。indexName='GSI1'|'GSI2'でGSI検索。全ページ取得 */
export async function query(table, pk, { skPrefix = null, indexName = null, skBetween = null } = {}) {
  const items = [];
  let key;
  const values = { ':pk': pk };
  const pkAttr = indexName ? `${indexName}PK` : 'PK';
  const skAttr = indexName ? `${indexName}SK` : 'SK';
  let cond = `${pkAttr} = :pk`;
  if (skPrefix) { cond += ` AND begins_with(${skAttr}, :skp)`; values[':skp'] = skPrefix; }
  if (skBetween) { cond += ` AND ${skAttr} BETWEEN :s AND :e`; values[':s'] = skBetween[0]; values[':e'] = skBetween[1]; }
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: table, IndexName: indexName ?? undefined,
      KeyConditionExpression: cond, ExpressionAttributeValues: values, ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

export async function scan(table, { filterExpression = null, names = {}, values = {} } = {}) {
  const items = [];
  let key;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: table,
      ...(filterExpression ? { FilterExpression: filterExpression } : {}),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
      ExclusiveStartKey: key,
    }));
    items.push(...(r.Items ?? []));
    key = r.LastEvaluatedKey;
  } while (key);
  return items;
}

export async function batchGet(table, keys) {
  if (keys.length === 0) return [];
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await ddb.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys.slice(i, i + 100) } } }));
    out.push(...(r.Responses?.[table] ?? []));
  }
  return out;
}

/** UpdateItem。add:ADD式(アトミック加算)、set:SET式、condition:ConditionExpression */
export async function updateItem(table, key, { add = {}, set = {}, condition = null, values = {} } = {}) {
  const names = {};
  const vals = { ...values };
  const sets = [];
  const adds = [];
  let i = 0;
  for (const [attr, v] of Object.entries(set)) {
    const nk = `#s${i}`; const vk = `:s${i}`; i++;
    names[nk] = attr; vals[vk] = v; sets.push(`${nk} = ${vk}`);
  }
  let j = 0;
  for (const [attr, n] of Object.entries(add)) {
    const nk = `#a${j}`; const vk = `:a${j}`; j++;
    names[nk] = attr; vals[vk] = n; adds.push(`${nk} ${vk}`);
  }
  const expr = [sets.length ? `SET ${sets.join(', ')}` : '', adds.length ? `ADD ${adds.join(', ')}` : ''].filter(Boolean).join(' ');
  try {
    const r = await ddb.send(new UpdateCommand({
      TableName: table, Key: key, UpdateExpression: expr,
      ...(condition ? { ConditionExpression: condition } : {}),
      ExpressionAttributeNames: names, ExpressionAttributeValues: vals, ReturnValues: 'ALL_NEW',
    }));
    return r.Attributes;
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') throw new ConditionalCheckFailed();
    throw e;
  }
}

/** TransactWriteItems(all-or-nothing)。ops = [{table,item,conditionNotExists}] */
export async function transactWrite(ops) {
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: ops.map((op) => ({
        Put: {
          TableName: op.table, Item: op.item,
          ...(op.conditionNotExists ? { ConditionExpression: 'attribute_not_exists(PK)' } : {}),
        },
      })),
    }));
  } catch (e) {
    if (e.name === 'TransactionCanceledException' || e.name === 'ConditionalCheckFailedException') throw new ConditionalCheckFailed(e.message);
    throw e;
  }
}
