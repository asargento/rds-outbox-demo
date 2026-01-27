#!/bin/bash

# Script to deploy DMS configuration after the main serverless stack is deployed
# Usage: ./scripts/deploy-dms.sh <stage> <region>

set -e

STAGE=${1:-dev}
REGION=${2:-us-east-1}
STACK_NAME="rds-outbox-demo-${STAGE}"
DMS_STACK_NAME="${STACK_NAME}-dms"

echo "Deploying DMS configuration for stack: ${STACK_NAME}"
echo "Region: ${REGION}"

# Get outputs from the main stack
echo "Fetching outputs from main stack..."
DB_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='DatabaseEndpoint'].OutputValue" \
    --output text)

DB_SECRET_ARN=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='DatabaseSecretArn'].OutputValue" \
    --output text)

KINESIS_STREAM_ARN=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='KinesisStreamArn'].OutputValue" \
    --output text)

VPC_ID=$(aws cloudformation describe-stacks \
    --stack-name "${STACK_NAME}" \
    --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='VpcId'].OutputValue" \
    --output text)

# Get subnet IDs from the VPC
echo "Finding subnets in VPC: ${VPC_ID}..."
SUBNET_IDS=$(aws ec2 describe-subnets \
    --filters "Name=vpc-id,Values=${VPC_ID}" \
    --query "Subnets[*].SubnetId" \
    --output text \
    --region "${REGION}")

# Convert space-separated to comma-separated
SUBNET_IDS_COMMA=$(echo $SUBNET_IDS | tr ' ' ',')

if [ -z "$DB_ENDPOINT" ] || [ -z "$DB_SECRET_ARN" ] || [ -z "$KINESIS_STREAM_ARN" ] || [ -z "$VPC_ID" ]; then
    echo "Error: Could not retrieve all required outputs from main stack"
    echo "DB_ENDPOINT: ${DB_ENDPOINT}"
    echo "DB_SECRET_ARN: ${DB_SECRET_ARN}"
    echo "KINESIS_STREAM_ARN: ${KINESIS_STREAM_ARN}"
    echo "VPC_ID: ${VPC_ID}"
    exit 1
fi

echo "Deploying DMS CloudFormation stack..."
aws cloudformation deploy \
    --template-file dms-setup.yaml \
    --stack-name "${DMS_STACK_NAME}" \
    --region "${REGION}" \
    --parameter-overrides \
        StackName="${STACK_NAME}" \
        DatabaseEndpoint="${DB_ENDPOINT}" \
        DatabaseSecretArn="${DB_SECRET_ARN}" \
        KinesisStreamArn="${KINESIS_STREAM_ARN}" \
        VpcId="${VPC_ID}" \
        SubnetIds="${SUBNET_IDS_COMMA}" \
    --capabilities CAPABILITY_NAMED_IAM

echo ""
echo "DMS stack deployed successfully!"
echo ""
echo "Next steps:"
echo "1. Start the replication task:"
echo "   aws dms start-replication-task \\"
echo "     --replication-task-arn \$(aws cloudformation describe-stacks \\"
echo "       --stack-name ${DMS_STACK_NAME} \\"
echo "       --region ${REGION} \\"
echo "       --query 'Stacks[0].Outputs[?OutputKey==\`ReplicationTaskArn\`].OutputValue' \\"
echo "       --output text) \\"
echo "     --start-replication-task-type start-replication \\"
echo "     --region ${REGION}"
echo ""
echo "2. Check replication task status:"
echo "   aws dms describe-replication-tasks \\"
echo "     --filters Name=replication-task-id,Values=${STACK_NAME}-replication-task \\"
echo "     --region ${REGION}"
