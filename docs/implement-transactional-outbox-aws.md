# Implementing the Transactional Outbox Pattern for Event-Driven Architecture in AWS

## The Problem: Dual-Write Dilemma

Imagine you're building a microservices architecture where your service needs to:
1. Update data in PostgreSQL
2. Publish an event to downstream systems (SQS, EventBridge, etc.)

The naive approach might look like this:

```typescript
// ❌ Problematic approach
await db.transaction(async (tx) => {
  await tx.query('INSERT INTO cars ...');
  await sqs.sendMessage(...); // What if this fails?
});
```

This creates a **dual-write problem**: you're writing to two different systems, and there's no guarantee they'll both succeed. If the database commit succeeds but the message publish fails, you've lost an event. If the message publish succeeds but the database commit fails, you've created a phantom event. Either way, your system state becomes inconsistent.

## Why Not Just Use Database Triggers?

Database triggers might seem like an elegant solution—let the database handle event emission automatically. However, they introduce several problems:

- **Tight coupling**: Business logic lives in the database, making it harder to test and maintain
- **Performance issues**: Triggers execute synchronously and can slow down transactions
- **Limited flexibility**: Hard to add retry logic, filtering, or transformation
- **Debugging complexity**: Database-level logic is harder to trace and debug

## The Solution: Transactional Outbox Pattern

The Transactional Outbox Pattern solves this by ensuring **atomicity** between your domain state changes and event creation. Here's how it works:

1. **Write domain data and outbox record in a single transaction**
2. **Use Change Data Capture (CDC) to asynchronously process outbox records**
3. **Publish events to your messaging infrastructure**

This guarantees that if your domain data is committed, the event is guaranteed to be published (eventually).

## AWS Implementation Architecture

Our implementation uses a pipeline of AWS-managed services:

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
    │
    │ fan-out
    ▼
Downstream Targets (SQS, Lambda, Step Functions)
```

### Why This Architecture?

- **No polling**: DMS streams changes in real-time from PostgreSQL WAL
- **No dual writes**: Events are created atomically with domain data
- **Durable**: All changes are anchored in PostgreSQL WAL
- **Replayable**: Can recover from downstream failures
- **Scalable**: Kinesis shards provide horizontal scaling

## Implementation Details

### 1. Outbox Table Schema

First, we create an outbox table in our PostgreSQL database:

```sql
CREATE TABLE IF NOT EXISTS outbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aggregate_type VARCHAR(100) NOT NULL,
    aggregate_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    event_data JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP
);

-- Enable logical replication (required for DMS CDC)
ALTER TABLE outbox REPLICA IDENTITY FULL;
```

Key points:
- **Append-only**: Only INSERT operations (no updates or deletes)
- **Immutable**: Once written, events are never modified
- **REPLICA IDENTITY FULL**: Required for DMS to capture all column data

### 2. Application Code: Writing to the Outbox

Here's how we write domain data and events atomically:

```typescript
const client = await dbPool.connect();

try {
  // Start transaction
  await client.query('BEGIN');

  // Insert domain data
  const carResult = await client.query(
    `INSERT INTO cars (make, model, year, color)
     VALUES ($1, $2, $3, $4)
     RETURNING id, make, model, year, color, created_at`,
    [body.make, body.model, body.year, body.color || null]
  );

  const car = carResult.rows[0];

  // Insert event into outbox (same transaction)
  const eventData = {
    carId: car.id,
    make: car.make,
    model: car.model,
    year: car.year,
    color: car.color,
    createdAt: car.created_at,
  };

  await client.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, event_data)
     VALUES ($1, $2, $3, $4)`,
    ['Car', car.id, 'CarCreated', JSON.stringify(eventData)]
  );

  // Commit transaction
  await client.query('COMMIT');
} catch (error) {
  // Rollback transaction on error
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
}
```

**Critical**: Both the domain data insert and the outbox insert happen in the same transaction. If either fails, both are rolled back.

### 3. CDC Consumer: Processing Outbox Events

AWS DMS captures changes from PostgreSQL WAL and streams them to Kinesis. Our Lambda function consumes these records and publishes them to EventBridge:

```typescript
export const handler = async (event: KinesisStreamEvent): Promise<void> => {
  const events = [];

  for (const record of event.Records) {
    const payload = Buffer.from(record.kinesis.data, "base64").toString("utf-8");
    const dmsRecord: DMSRecord = JSON.parse(payload);

    // Check if this is an insert on the outbox table
    if (
      dmsRecord.metadata?.["record-type"] === "data" &&
      dmsRecord.metadata?.operation === "insert" &&
      dmsRecord.metadata?.["table-name"] === "outbox"
    ) {
      const outboxData = dmsRecord.data;
      const eventData = outboxData.event_data || outboxData.payload || {};

      // Create EventBridge event
      const eventBridgeEvent = {
        Source: `outbox.${outboxData.aggregate_type.toLowerCase()}`,
        DetailType: outboxData.event_type,
        Detail: JSON.stringify({
          aggregateId: outboxData.aggregate_id,
          aggregateType: outboxData.aggregate_type,
          eventId: outboxData.id,
          eventData: eventData,
          timestamp: outboxData.created_at || new Date().toISOString(),
        }),
        EventBusName: EVENT_BUS_NAME,
      };

      events.push(eventBridgeEvent);
    }
  }

  // Batch publish to EventBridge (max 10 events per batch)
  if (events.length > 0) {
    const batches = [];
    for (let i = 0; i < events.length; i += 10) {
      batches.push(events.slice(i, i + 10));
    }

    for (const batch of batches) {
      const command = new PutEventsCommand({ Entries: batch });
      await eventBridgeClient.send(command);
    }
  }
};
```

## Delivery Semantics

| Property                   | Guarantee     |
| -------------------------- | ------------- |
| Atomic DB + event creation | ✅ Yes         |
| Event durability           | ✅ Yes         |
| Replayability              | ✅ Yes         |
| Ordering                   | Per shard     |
| Delivery                   | At-least-once |

**Important**: Because delivery is at-least-once, consumers must be **idempotent**. Each event has a stable identifier (the `id` field) that can be used as an idempotency key.

## Failure Modes and Recovery

| Failure Scenario          | Outcome       | Data Loss | Recovery        |
| ------------------------- | ------------- | --------- | --------------- |
| App crashes before commit | No WAL entry  | No        | N/A             |
| App crashes after commit  | WAL retained  | No        | CDC replay      |
| DMS task interruption     | CDC paused    | No        | Resume task     |
| Kinesis throttling        | Backpressure  | No        | Scale shards    |
| Lambda failure            | Batch retried | No        | Automatic retry |
| EventBridge unavailable   | Retry / DLQ   | No        | Managed retry   |

Durability is anchored in PostgreSQL WAL; all downstream stages are replayable.

## Cost Considerations

For a typical production workload (~10k events/day, average event size: 1–5 KB) in `eu-west-1`:

| Component                      | Estimated Cost     |
| ------------------------------ | ------------------ |
| AWS DMS (t3.micro, CDC-only)   | €15–30             |
| Kinesis Data Streams (1 shard) | ~€11               |
| AWS Lambda                     | €1–3               |
| Amazon EventBridge             | <€0.5              |
| **Total (approx.)**            | **€27–45 / month** |

**Note**: DMS dominates the cost for low-volume workloads. Lambda and EventBridge costs are negligible. These costs are typically lower than the operational cost of data inconsistency incidents.

## Scaling Characteristics

| Component   | Scaling Mechanism     |
| ----------- | --------------------- |
| PostgreSQL  | WAL-based             |
| DMS         | Vertical scaling      |
| Kinesis     | Horizontal (shards)   |
| Lambda      | Automatic concurrency |
| EventBridge | Fully managed         |

**Throughput Guidelines**:
- < 1M events/day: 1 shard
- 1–10M events/day: 2–5 shards
- > 10M events/day: Partitioned streams

Ordering guarantees are maintained per shard.

## Why Not Polling?

You might wonder: why not just poll the outbox table periodically? While polling could work for very low-traffic scenarios, it has significant drawbacks:

- **Resource waste**: Periodic queries consume resources even when no events are present
- **Latency**: Events are only detected at polling intervals
- **Scalability**: Doesn't scale well with increasing event volume
- **Operational burden**: Requires tuning polling intervals and managing database load

CDC with DMS provides real-time processing without these limitations.

## Cloud Portability

One of the key advantages of this pattern is its cloud-agnostic potential. While this implementation uses AWS-native services (DMS, Kinesis, Lambda, EventBridge), the same principles apply across other cloud providers:

- **CDC layer**: Can be implemented with [Debezium](https://debezium.io) or custom WAL readers
- **Event bus**: Could be replaced with [NATS JetStream](https://docs.nats.io/using-nats/developer/develop_jetstream), [Apache Kafka](https://kafka.apache.org), or [Pulsar](https://pulsar.apache.org)

This enables organizations to decouple application logic from cloud-specific messaging services, providing portability and flexibility.

## Key Takeaways

1. **Atomicity is guaranteed**: Domain data and events are written in a single transaction
2. **No dual writes**: Eliminates the risk of inconsistent state
3. **Durable and replayable**: All events are anchored in PostgreSQL WAL
4. **AWS-native**: Uses production-ready, managed AWS services
5. **Cost-effective**: Low-volume pipelines cost <€50/month
6. **Scalable**: Horizontal scaling via Kinesis shards

## Getting Started

If you want to try this pattern yourself, check out the [complete implementation](https://github.com/asargento/rds-outbox-demo) which includes:

- Serverless Framework configuration
- Lambda functions for creating entities and consuming CDC events
- DMS setup scripts
- Database schema
- Complete deployment instructions

The pattern is production-ready and can be adapted to your specific use case.

## Conclusion

The Transactional Outbox Pattern with AWS DMS CDC provides a robust, scalable solution for event-driven architectures. By leveraging PostgreSQL WAL and AWS-managed services, we achieve strong correctness guarantees while keeping application complexity minimal.

Whether you're building microservices, implementing event sourcing, or integrating with downstream systems, this pattern ensures your events are never lost and your system state remains consistent.

---

**References**:
- [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html)
- [AWS DMS Change Data Capture (CDC)](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Task.CDC.html)
- [Using PostgreSQL as an AWS DMS source](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html)
