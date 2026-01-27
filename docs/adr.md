# Transactional Outbox Pattern for Event-Driven Architecture

## Context and Problem Statement

Many services need to persist domain state changes in PostgreSQL while emitting integration events to downstream systems (SQS, EventBridge, etc.). Naive approaches—such as writing directly to queues, invoking messaging APIs inside transactions, or relying on database triggers—lead to dual-write problems, including lost events, phantom events, inconsistent system state, and difficult-to-debug production failures. These issues worsen as systems scale and services are decoupled.

The solution must guarantee atomicity between database state changes and event creation, avoid distributed transactions, provide at-least-once delivery with replay, minimize application-level complexity, and use AWS-managed services and supported integration patterns.

## Considered Options

* **Direct writes to messaging infrastructure** - Application code writes directly to SQS, EventBridge, or other messaging services within or after database transactions
* **Database triggers** - Using PostgreSQL triggers to emit events when data changes
* **Transactional Outbox Pattern with Polling** - Application writes domain data and outbox records in a single database transaction, with a scheduled Lambda function periodically polling the outbox table for new events and publishing them to EventBridge or other messaging infrastructure
* **Transactional Outbox Pattern with AWS DMS CDC** - Application writes domain data and outbox records in a single database transaction, with AWS DMS (Change Data Capture) streaming changes from PostgreSQL WAL to Kinesis Data Streams, Lambda consuming CDC records and publishing integration events to EventBridge
* **Transactional Outbox Pattern with AWS DMS CDC using EventBridge Pipes** - Application writes domain data and outbox records in a single database transaction, with AWS DMS (Change Data Capture) streaming changes from PostgreSQL WAL to Kinesis Data Streams, EventBridge Pipes connecting Kinesis directly to EventBridge with an optional transformation Lambda for event transformation, eliminating the need for a separate CDC Consumer Lambda 

## Decision Outcome

**Chosen option: "Transactional Outbox Pattern with AWS DMS CDC"**, because it is the only option that meets the key requirements: it guarantees atomicity between database state changes and event creation without distributed transactions, provides durable and replayable event delivery, eliminates dual-write inconsistencies, and uses AWS-managed services with supported integration patterns.

**Rejected alternatives:**

* **Direct writes to messaging infrastructure** and **Database triggers** were rejected because they fail to solve the dual-write problem and introduce reliability issues. Direct writes cannot guarantee atomicity between database commits and message delivery, leading to lost events, phantom events, and inconsistent system state. Database triggers create tight coupling, are difficult to test and debug, and can cause performance issues under load.

* **Transactional Outbox Pattern with Polling** was rejected because polling introduces significant overhead and inefficiencies. The approach requires periodic database queries that consume resources even when no events are present, introduces latency (events are only detected at polling intervals), does not scale well with increasing event volume, and wastes compute resources on empty polls. While it could work for very low-traffic scenarios, the operational burden and scalability limitations make it unsuitable for production systems.

* **Transactional Outbox Pattern with AWS DMS CDC using EventBridge Pipes** was rejected because it adds unnecessary complexity without providing significant benefits over the standard CDC approach. EventBridge Pipes introduces an additional abstraction layer that complicates debugging and monitoring, provides limited advantages over a dedicated Lambda consumer (which offers more flexibility for error handling, batching strategies, and custom logic), and increases the operational surface area. The standard CDC approach with a Lambda consumer is more transparent, easier to troubleshoot, and provides better control over event processing.

### Consequences

* Good, because:
  - Strong correctness guarantees: atomicity between domain state changes and event creation
  - Operationally scalable: horizontal scaling via Kinesis shards, vertical scaling via DMS instances
  - Full replayability: events are anchored in PostgreSQL WAL, enabling recovery from downstream failures
  - Minimal application complexity: application only needs to write to outbox table in same transaction
  - Cost-effective: low-volume pipelines (<10k events/day) cost <€50/month
  - AWS-native and managed: uses production-ready, supported AWS services
  - Cloud-agnostic potential: pattern can be adapted to other cloud providers using alternative CDC tools (e.g., Debezium) and event buses (e.g., Kafka, NATS JetStream)

* Bad, because:
  - Eventual consistency by design: events are delivered asynchronously, not synchronously
  - Additional infrastructure components: requires DMS, Kinesis, Lambda, and EventBridge setup and maintenance
  - Consumer-side idempotency required: because delivery is at-least-once, consumers must handle duplicate events
  - DMS cost dominates: for low-volume workloads, DMS is the primary cost component (~€15-30/month)

## Architecture Overview

The solution uses a pipeline of AWS-managed services to implement the Transactional Outbox pattern:

```
PostgreSQL
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

**Core Flow:**
1. The application writes domain data and outbox records **in a single database transaction**
2. PostgreSQL WAL records committed changes
3. AWS DMS streams relevant changes (CDC) to Kinesis
4. Lambda consumes CDC records and publishes integration events
5. EventBridge routes events to interested consumers

This ensures: no polling, no dual writes, no lost events, and full replayability.

**Note:** Kinesis Data Streams is a mandatory intermediary when using AWS DMS for PostgreSQL CDC, as DMS cannot invoke Lambda directly. Kinesis provides buffering, replay, backpressure handling, and native Lambda integration.

>This architecture is **conceptually equivalent** to DynamoDB Streams, which provides a managed change stream directly from DynamoDB tables.
> DynamoDB Streams can be viewed as a fully managed CDC + buffer + Lambda trigger pipeline.
> The proposed PostgreSQL solution composes the same guarantees explicitly using WAL, DMS, Kinesis, and Lambda.
>This reference is provided for conceptual alignment only.


## Implementation Details

### Outbox Table Schema

```sql
CREATE TABLE outbox_events (
  id UUID PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL, -- Domain Event
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
```

**Constraints:**
- Append-only (INSERT only)
- Written in the same transaction as domain changes
- Represents explicit business events
- No triggers are required
- CDC consumes rows asynchronously

### Application Responsibilities

- Perform domain mutations and outbox inserts atomically
- Treat outbox entries as immutable facts
- Avoid direct interaction with messaging infrastructure

### Change Data Capture (CDC)

- AWS DMS reads PostgreSQL WAL changes
- Streams only the outbox table
- Produces CDC events to Kinesis Data Streams
- Guarantees durability and ordering per shard
- Supports replay in case of failures


## Delivery Semantics

| Property                   | Guarantee     |
| -------------------------- | ------------- |
| Atomic DB + event creation | Yes           |
| Event durability           | Yes           |
| Replayability              | Yes           |
| Ordering                   | Per shard     |
| Delivery                   | At-least-once |

**Idempotency Requirements:**
- Each event must have a stable identifier (event.id could be used as idempotency key)
- Consumers must be idempotent
- FIFO SQS queues may be used where strict ordering is required

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

## Cost Estimates

Indicative costs for a typical production workload in `eu-west-1` (~10k outbox events per day, average event size: 1–5 KB, near real-time processing, single-region deployment):

| Component                      | Estimated Cost     |
| ------------------------------ | ------------------ |
| AWS DMS (t3.micro, CDC-only)   | €15–30             |
| Kinesis Data Streams (1 shard) | ~€11               |
| AWS Lambda                     | €1–3               |
| Amazon EventBridge             | <€0.5              |
| **Total (approx.)**            | **€27–45 / month** |

These costs are typically lower than the operational cost of data inconsistency incidents. DMS dominates cost. Lambda and EventBridge are negligible.

## Scaling Characteristics

| Component   | Scaling Mechanism     |
| ----------- | --------------------- |
| PostgreSQL  | WAL-based             |
| DMS         | Vertical scaling      |
| Kinesis     | Horizontal (shards)   |
| Lambda      | Automatic concurrency |
| EventBridge | Fully managed         |

**Throughput Guidelines:**

| Workload         | Suggested Setup     |
| ---------------- | ------------------- |
| < 1M events/day  | 1 shard             |
| 1–10M events/day | 2–5 shards          |
| > 10M events/day | Partitioned streams |

Ordering guarantees are maintained per shard.

## Cloud Portability

One of the key advantages of the PostgreSQL + Outbox + CDC pattern is its cloud-agnostic potential. While this ADR describes an AWS-native implementation using DMS, Kinesis, Lambda, and EventBridge, the same principles apply across other cloud providers or self-managed environments.

The CDC layer can be implemented with tools like **[Debezium](https://debezium.io)** or **custom WAL reader**, and the event bus could be replaced with **[NATS JetStream](https://docs.nats.io/using-nats/developer/develop_jetstream)**, **[Apache Kafka](https://kafka.apache.org)**, or **[Pulsar](https://pulsar.apache.org)**, preserving the same guarantees: **atomicity**, **durability**, **replayability**, and **at-least-once delivery**.

This approach enables organizations to decouple application logic from cloud-specific messaging services, providing portability, flexibility, and the ability to integrate with low-latency event-driven systems beyond AWS.

> Cloud-agnostic design allows migration or hybrid deployments while keeping the core outbox semantics intact.

## References

- [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html)
- [AWS DMS Change Data Capture (CDC)](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Task.CDC.html)
- [Using a PostgreSQL database as an AWS DMS source](https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Source.PostgreSQL.html#CHAP_Source.PostgreSQL.Security)
