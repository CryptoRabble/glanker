import { createClient } from 'redis';

let redisClient = null;

export async function getRedisClient() {
  if (!redisClient) {
    console.log('Creating new Redis client');
    const redisUrl = process.env.REDIS_URL?.replace(/['"]/g, '');
    
    if (!redisUrl) {
      throw new Error('Redis URL not configured');
    }

    redisClient = createClient({
      url: redisUrl,
      socket: {
        tls: true,
        rejectUnauthorized: false
      }
    });

    redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
      redisClient = null;
    });

    redisClient.on('connect', () => {
      console.log('Redis client connected');
    });

    try {
      await redisClient.connect();
    } catch (error) {
      console.error('Failed to connect to Redis:', error);
      redisClient = null;
      throw error;
    }
  }

  return redisClient;
}

export async function safeRedisGet(key) {
  try {
    console.log(`Attempting to get Redis key: ${key}`);
    const client = await getRedisClient();
    const value = await client.get(key);
    console.log(`Redis GET - Key: ${key}, Value:`, value);
    return value;
  } catch (error) {
    console.error(`Error getting Redis key ${key}:`, error);
    return null;
  }
}

export async function safeRedisSet(key, value) {
  try {
    console.log(`Attempting to set Redis key: ${key}`);
    const client = await getRedisClient();
    await client.set(key, value);
    console.log(`Redis SET - Key: ${key}, Value set successfully`);
  } catch (error) {
    console.error(`Error setting Redis key ${key}:`, error);
  }
}

export async function safeRedisDel(key) {
  try {
    console.log(`Attempting to delete Redis key: ${key}`);
    const client = await getRedisClient();
    await client.del(key);
    console.log(`Redis DEL - Key: ${key} deleted successfully`);
  } catch (error) {
    console.error(`Error deleting Redis key ${key}:`, error);
  }
}