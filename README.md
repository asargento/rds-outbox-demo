# Transactional Outbox Pattern Demo

This project demonstrates the **Transactional Outbox Pattern** for Event-Driven Architecture using AWS services. The architecture ensures reliable event publishing by writing events to an outbox table within the same database transaction as the business data.

Read the accompanying documentation for further details:
- Article format: [`./docs/implement-transactional-outbox-aws.md`](./docs/implement-transactional-outbox-aws.md) 
- Architecture Decision Record format: [`./docs/adr.md`](./docs/adr.md)

## Architecture Overview

```
PostgreSQL (RDS)
    │
    │ Write-Ahead Log / WAL (logical replication)
    ▼
AWS DMS (Change Data Capture, CDC)
    │
    │ CDC events
    ▼
Kinesis Data Streams
    │
    │ batch records
    ▼
AWS Lambda (CDC Consumer)
    │
    │ integration events
    ▼
Amazon EventBridge (Custom Bus)
```

## Components

1. **PostgreSQL Database (RDS)**
   - `cars` table: Stores car entities
   - `outbox` table: Stores events to be published (Transactional Outbox Pattern)

2. **API Gateway + Lambda**
   - Creates cars and writes events to the outbox table in a single transaction

3. **AWS DMS (Database Migration Service)**
   - Captures changes from PostgreSQL using logical replication
   - Publishes changes to Kinesis Data Streams

4. **Kinesis Data Streams**
   - Receives CDC events from DMS
   - Provides buffering and ordering

5. **Lambda (CDC Consumer)**
   - Consumes events from Kinesis
   - Publishes integration events to EventBridge

6. **EventBridge Custom Bus**
   - Receives and routes integration events

## Prerequisites

- AWS CLI configured with appropriate credentials
- Node.js 22+ and npm
- Serverless Framework CLI installed: 
  ```bash
  npm install -g osls
  # Or use npx (no global install needed):
  npx osls --version
  ```
  Note: This project uses [oss-serverless/serverless](https://github.com/oss-serverless/serverless), a maintained alternative to Serverless Framework v3
- PostgreSQL client tools (for running schema setup)

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Build the Project

```bash
npm run build
```

### 3. Deploy Infrastructure

```bash
npm run deploy
# Or with specific stage/region:
serverless deploy --stage dev --region us-east-1
```

This will create:
- RDS PostgreSQL instance (t3.micro, publicly accessible for demo)
- Kinesis Data Stream
- EventBridge Custom Bus
- API Gateway with Lambda function
- Lambda function for CDC consumption

**Note:** The RDS instance is configured to be publicly accessible for demo purposes. In production, you should use a VPC with private subnets and proper security groups.

**Note:** The deployment will output important values including:
- API Gateway endpoint URL
- Database endpoint
- Database secret ARN
- Kinesis stream name
- EventBridge bus name

### 4. Set Up Database Schema

After deployment, you need to run the database schema to create the `cars` and `outbox` tables.

1. Get the database endpoint and secret ARN from CloudFormation outputs:
   ```bash
   aws cloudformation describe-stacks \
     --stack-name rds-outbox-demo-dev \
     --query "Stacks[0].Outputs[?OutputKey=='DatabaseEndpoint' || OutputKey=='DatabaseSecretArn']"
   ```

2. Run the schema setup script:
   ```bash
   ./scripts/setup-db-schema.sh <DatabaseEndpoint> <DatabaseSecretArn>
   ```

Alternatively, you can connect to the database manually and run the schema file:
```bash
# Retrieve the database password
DB_PASSWORD=$(aws secretsmanager get-secret-value --secret-id <DatabaseSecretArn> --query SecretString --output text | jq -r .password)

# Connect and run schema
PGPASSWORD="$DB_PASSWORD" psql -h <DatabaseEndpoint> -U dbadmin -d outboxdb -f database/schema.sql
```

Or use AWS RDS Query Editor (if available in your region) to execute the contents of `database/schema.sql`.

### 6. Configure AWS DMS

DMS setup can be done using the provided CloudFormation template and deployment script. This is the recommended approach:

#### 6.1 Deploy DMS Configuration (Recommended)

Use the provided script to deploy DMS configuration:

```bash
./scripts/deploy-dms.sh dev us-east-1
```

This script will:
- Fetch outputs from your main serverless stack (database endpoint, secret ARN, Kinesis stream ARN, VPC ID)
- Automatically discover subnets in your VPC
- Deploy a CloudFormation stack (`rds-outbox-demo-dev-dms`) with all DMS resources:
  - IAM role for DMS to write to Kinesis
  - Security group for DMS replication instance
  - VPC endpoint for Kinesis (required for DMS replication instance connectivity)
  - DMS replication subnet group
  - DMS replication instance (dms.t3.micro)
  - DMS source endpoint (PostgreSQL)
  - DMS target endpoint (Kinesis)
  - DMS replication task (CDC mode, configured to capture all changes from the `outbox` table)

The script will also provide instructions for starting the replication task after deployment.

#### 6.2 Start the Replication Task

After fixing the password and verifying the connection, start the replication task:

```bash
STACK_NAME="rds-outbox-demo-dev"
REGION="us-east-1"
DMS_STACK_NAME="${STACK_NAME}-dms"

REPLICATION_TASK_ARN=$(aws cloudformation describe-stacks \
  --stack-name "${DMS_STACK_NAME}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ReplicationTaskArn'].OutputValue" \
  --output text)

aws dms start-replication-task \
  --replication-task-arn "${REPLICATION_TASK_ARN}" \
  --start-replication-task-type start-replication \
  --region "${REGION}"
```

Verify the replication task is running:

```bash
aws dms describe-replication-tasks \
  --filters Name=replication-task-id,Values=${STACK_NAME}-replication-task \
  --region "${REGION}" \
  --query "ReplicationTasks[0].Status"
```

## Usage

### Create a Car

```bash
curl -X POST https://<ApiEndpoint>/cars \
  -H "Content-Type: application/json" \
  -d '{
    "make": "Toyota",
    "model": "Camry",
    "year": 2023,
    "color": "Blue"
  }'
```

### Expected Flow

1. API receives the request
2. Lambda function starts a database transaction
3. Car is inserted into `cars` table
4. Event is inserted into `outbox` table (same transaction)
5. Transaction commits
6. DMS captures the change via logical replication
7. DMS publishes to Kinesis
8. CDC Consumer Lambda processes the Kinesis record
9. Event is published to EventBridge

### Monitor Events

You can monitor events in EventBridge by:
1. Creating an EventBridge rule that matches `CarCreated` events
2. Setting up CloudWatch Logs or SNS notifications
3. Using EventBridge console to view events

## Project Structure

```
.
├── database/
│   └── schema.sql
├── lambda/
│   ├── create-car/
│   │   └── src/
│   │       └── index.ts
│   └── cdc-consumer/
│       └── src/
│           └── index.ts
├── scripts/
│   ├── deploy-dms.sh
│   └── setup-db-schema.sh
├── dms-setup.yaml
├── serverless.yml
├── package.json
├── tsconfig.json
└── README.md
```

## Cleanup

To remove all resources:

```bash
npm run remove
# Or:
serverless remove --stage dev
```

**Note:** Make sure to:
1. Delete the DMS CloudFormation stack (if deployed):
   ```bash
   aws cloudformation delete-stack --stack-name rds-outbox-demo-dev-dms --region <region>
   ```
   Or manually:
   - Stop and delete the DMS replication task
   - Delete DMS endpoints
   - Delete DMS replication instance
2. Manually delete any EventBridge rules you created

## Important Notes

- This is a **demo project** and uses `RemovalPolicy.DESTROY` for easy cleanup
- The RDS instance uses `t3.micro` which is suitable for demos but may have performance limitations
- DMS setup is complex and may require additional IAM roles and permissions
- In production, consider:
  - Using RDS Proxy for connection pooling
  - Implementing event deduplication
  - Adding monitoring and alerting
  - Using dead-letter queues for failed events
  - Implementing idempotency keys

## Troubleshooting

### Lambda can't connect to RDS
- Verify the RDS instance is publicly accessible
- Check security group rules allow traffic on port 5432 from 0.0.0.0/0 (for demo)
- Verify the database password is correctly retrieved from Secrets Manager
- Check Lambda execution role has permissions to read from Secrets Manager

### DMS not capturing changes
- Verify logical replication is enabled in RDS parameter group (`rds.logical_replication = 1`)
- Check DMS replication task status (should be "running")
- Review DMS CloudWatch logs for errors
- Verify DMS source endpoint can connect to RDS (test endpoint connection in DMS console)
- Ensure VPC endpoint for Kinesis is created and accessible from DMS replication instance
- Check that the replication task is configured to capture changes from the `outbox` table

### Events not appearing in EventBridge
- Check CDC Consumer Lambda logs
- Verify Kinesis stream has records
- Check EventBridge permissions
- Review Lambda execution role permissions

## License

MIT
