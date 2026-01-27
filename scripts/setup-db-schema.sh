#!/bin/bash

# Script to run database schema setup
# Usage: ./scripts/setup-db-schema.sh <database-endpoint> <secret-arn>

set -e

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <database-endpoint> <secret-arn>"
    echo "Example: $0 outbox-demo-stack-outboxdatabase-xxxxx.us-east-1.rds.amazonaws.com arn:aws:secretsmanager:us-east-1:123456789:secret:..."
    exit 1
fi

DB_ENDPOINT=$1
SECRET_ARN=$2

echo "Fetching database password from Secrets Manager..."
DB_PASSWORD=$(aws secretsmanager get-secret-value \
    --secret-id "$SECRET_ARN" \
    --query SecretString \
    --output text | jq -r .password)

if [ -z "$DB_PASSWORD" ]; then
    echo "Error: Could not retrieve database password"
    exit 1
fi

echo "Connecting to database and running schema setup..."

PGPASSWORD="$DB_PASSWORD" psql \
    -h "$DB_ENDPOINT" \
    -U dbadmin \
    -d outboxdb \
    -f database/schema.sql

echo "Schema setup completed successfully!"
