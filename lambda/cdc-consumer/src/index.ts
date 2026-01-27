import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";

import { KinesisStreamEvent } from "aws-lambda";

const eventBridgeClient = new EventBridgeClient({});
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

interface OutboxRecord {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  event_data: any;
  created_at?: string;
}

interface DMSRecord {
  metadata: {
    "record-type": string;
    operation: string;
    "table-name": string;
  };
  data: {
    id: string;
    aggregate_type: string;
    aggregate_id: string;
    event_type: string;
    event_data?: any;
    payload?: any;
    created_at?: string;
  };
}

export const handler = async (event: KinesisStreamEvent): Promise<void> => {
  console.log(`Processing ${event.Records.length} Kinesis records`);

  const events = [];

  for (const record of event.Records) {
    try {
      const payload = Buffer.from(record.kinesis.data, "base64").toString(
        "utf-8"
      );
      const dmsRecord: DMSRecord = JSON.parse(payload);

      console.log("DMS Record:", JSON.stringify(dmsRecord, null, 2));

      // Check if this is a data record for the outbox table
      // (redundant if using event source mapping filters in serverless.yml)
      if (
        dmsRecord.metadata?.["record-type"] === "data" &&
        dmsRecord.metadata?.operation === "insert" &&
        dmsRecord.metadata?.["table-name"] === "outbox" &&
        dmsRecord.data
      ) {
        const outboxData = dmsRecord.data;

        // Use event_data if available, otherwise use payload
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
        console.log(
          `Prepared event: ${outboxData.event_type} for aggregate ${outboxData.aggregate_id}`
        );
      } else {
        console.log(
          `Skipping non-insert record or wrong table: ${JSON.stringify(
            dmsRecord.metadata
          )}`
        );
      }
    } catch (error: any) {
      console.error("Error processing Kinesis record:", error);
      console.error("Record data:", record.kinesis.data);
      // Continue processing other records
    }
  }

  // Batch publish to EventBridge (max 10 events per batch)
  if (events.length > 0) {
    const batches = [];
    for (let i = 0; i < events.length; i += 10) {
      batches.push(events.slice(i, i + 10));
    }

    for (const batch of batches) {
      try {
        const command = new PutEventsCommand({
          Entries: batch,
        });
        const response = await eventBridgeClient.send(command);

        if (response.FailedEntryCount && response.FailedEntryCount > 0) {
          console.error("Some events failed to publish:", response.Entries);
          // Log failed entries for debugging
          response.Entries?.forEach((entry, index) => {
            if (entry.ErrorCode) {
              console.error(`Failed entry ${index}:`, {
                ErrorCode: entry.ErrorCode,
                ErrorMessage: entry.ErrorMessage,
                Event: batch[index],
              });
            }
          });
        } else {
          console.log(
            `Successfully published ${batch.length} events to EventBridge`
          );
        }
      } catch (error: any) {
        console.error("Error publishing to EventBridge:", error);
        throw error;
      }
    }
  } else {
    console.log("No events to publish");
  }
};
