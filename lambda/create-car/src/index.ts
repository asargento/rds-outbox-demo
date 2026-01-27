import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Pool } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let pool: Pool | null = null;
const secretsClient = new SecretsManagerClient({});

async function getDatabasePool(): Promise<Pool> {
  if (pool) {
    return pool;
  }

  let password = process.env.DB_PASSWORD;
  
  // If DB_SECRET_ARN is provided, fetch password from Secrets Manager
  if (process.env.DB_SECRET_ARN && !password) {
    try {
      const command = new GetSecretValueCommand({
        SecretId: process.env.DB_SECRET_ARN,
      });
      const response = await secretsClient.send(command);
      const secret = JSON.parse(response.SecretString || '{}');
      password = secret.password || secret.DB_PASSWORD;
    } catch (error) {
      console.error('Error fetching secret:', error);
      throw error;
    }
  }

  pool = new Pool({
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME!,
    user: process.env.DB_USER!,
    password: password!,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 5, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  return pool;
}

interface CreateCarRequest {
  make: string;
  model: string;
  year: number;
  color?: string;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  // CORS headers
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const body: CreateCarRequest = JSON.parse(event.body || '{}');

    // Validate input
    if (!body.make || !body.model || !body.year) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Missing required fields: make, model, year',
        }),
      };
    }

    if (body.year < 1900 || body.year > new Date().getFullYear() + 1) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: 'Invalid year',
        }),
      };
    }

    const dbPool = await getDatabasePool();
    const client = await dbPool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Insert car
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

      console.log(`Car created successfully: ${car.id}`);

      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({
          message: 'Car created successfully',
          car: {
            id: car.id,
            make: car.make,
            model: car.model,
            year: car.year,
            color: car.color,
            createdAt: car.created_at,
          },
        }),
      };
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error: any) {
    console.error('Error creating car:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Internal server error',
        message: error.message,
      }),
    };
  }
};
