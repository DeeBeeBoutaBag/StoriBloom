// api/ddbClient.js
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const REGION = process.env.AWS_REGION || 'us-west-2';

// Native client
const ddbNative = new DynamoDBClient({ region: REGION });

// Document client (auto-marshals JS <-> DynamoDB)
export const ddb = DynamoDBDocumentClient.from(ddbNative, {
  marshallOptions: { removeUndefinedValues: true },
});
