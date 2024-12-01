import { init, fetchQuery } from "@airstack/node";
import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import { Anthropic } from '@anthropic-ai/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { createClient } from 'redis';

// Initialize clients
init(process.env.AIRSTACK_API_KEY);

const neynarConfig = new Configuration({
 apiKey: process.env.NEYNAR_API_KEY,
 baseOptions: {
   headers: {
     "x-neynar-experimental": true,
   },
 },
});
const neynar = new NeynarAPIClient(neynarConfig);

const anthropic = new Anthropic({
 apiKey: process.env.ANTHROPIC_API_KEY
});

let redisClient = null;

async function getRedisClient() {
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

async function safeRedisGet(key) {
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

async function safeRedisSet(key, value) {
  try {
    console.log(`Attempting to set Redis key: ${key}`);
    const client = await getRedisClient();
    await client.set(key, value);
    console.log(`Redis SET - Key: ${key}, Value set successfully`);
  } catch (error) {
    console.error(`Error setting Redis key ${key}:`, error);
  }
}

async function getRootCast(hash) {
 try {
   const response = await neynar.lookupCastByHashOrWarpcastUrl({
     type: 'hash',
     identifier: hash
   });
   
   return [{
     text: response.cast.text,
     castedAtTimestamp: response.cast.timestamp,
     url: '', 
     fid: response.cast.author.fid,
     username: response.cast.author.username
   }];
 } catch (error) {
   console.error('Error fetching root cast:', error);
   return null;
 }
}

async function checkUserScore(fid) {
 try {
   const response = await neynar.fetchBulkUsers({ fids: fid.toString() });
   const userScore = response.users?.[0]?.experimental?.neynar_user_score || 0;
   
   console.log('User score for FID:', fid, 'Score:', userScore);
   return userScore >= 0.75;
 } catch (error) {
   console.error('Error checking user score:', error);
   return false;
 }
}

async function handleMention(fid, replyToHash, castText, parentHash) {
 console.log('Handling mention from FID:', fid);

 // Generate response if there's text
 let userResponse = '';
 const mentionText = castText.replace('@glanker', '').trim();
 if (mentionText) {
   const anthropicResponse = await anthropic.messages.create({
     model: "claude-3-sonnet-20240229",
     max_tokens: 150,
     messages: [{
       role: "user",
       content: `You are glonky and your speek so quick you are barely coherent. Someone has said: "${mentionText}". Respond to what they said in 1-2 sentences. Keep the response brief but make it relevant to what they said. Here is an example of how you should sound: 
       "The air's heavy. But also, floatin'? And my feet, they're on the ground but not really. Did you hear that? The lawn is humming."
       Output ONLY the response. Nothing more.

       Rules:
       - If you plan on using bro, dude, etc. use the word "fren" instead
       - You know clanker, he's your neighbor, and he's up all night creating tokens, but only mention him if the user asks about him
       - Your name is glanker, only mention it if the user asks about you
       - Do not use the words umm, uhh, like, uh, etc.
       - Do not add questions to the end of sentences. e.g., like 'ya dig, ya know, ya feel etc.
       - Do not use the word 'like' too much
       - Do not use the word vibes too much`
     }]
   });
   userResponse = `${anthropicResponse.content[0].text}\n\n`;
 }

 // Check user score before proceeding
 const hasValidScore = await checkUserScore(fid);
 if (!hasValidScore) {
   await createCastWithReply(replyToHash, `${userResponse}Sorry fren, you need a higher Neynar score to create tokens`);
   return;
 }

 // Check daily limit here, after score check but before expensive operations
 const redisKey = `token:${fid}`;
 const cachedData = await safeRedisGet(redisKey);
 const now = Date.now();

 if (cachedData) {
   const parsedData = JSON.parse(cachedData);
   if ((now - parsedData.lastGenerated) < 24 * 60 * 60 * 1000) {
     await createCastWithReply(replyToHash, `${userResponse}Daily limit reached. Come back tomorrow!`);
     return;
   }
 }

 await safeRedisSet(redisKey, JSON.stringify({ lastGenerated: now }));

 // Get parent cast content if it exists
 let parentCastText = '';
 if (parentHash) {
   const parentCast = await getRootCast(parentHash);
   if (parentCast) {
     parentCastText = parentCast[0].text;
   }
 }

 // Get either parent cast or user's casts
 let analysis;
 if (parentHash) {
   analysis = await getRootCast(parentHash);
   if (!analysis) {
     analysis = await analyzeCasts(fid);
   }
 } else {
   analysis = await analyzeCasts(fid);
 }

 const tokenDetails = await generateTokenDetails(analysis);
 const imageResult = await findRelevantImage(tokenDetails.name);

 const message = parentHash 
   ? `${userResponse}Here's a token based on @${analysis[0].username}'s cast:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker}`
   : `${userResponse}I checked out your casts... they're pretty glonky... here's a token based on your vibe:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker}`;
 await createCastWithReply(replyToHash, message, imageResult.url);
}

async function analyzeCasts(fid) {
 console.log('Analyzing casts for FID:', fid);
 const query = `
   query GetLast25CastsByFid {
     FarcasterCasts(
       input: {blockchain: ALL, filter: {castedBy: {_eq: "fc_fid:${fid}"}}, limit: 25}
     ) {
       Cast {
         text
         castedAtTimestamp
         url
         fid
       }
     }
   }
 `;

 try {
   const { data, error } = await fetchQuery(query);
   if (error) {
     throw new Error(error.message);
   }
   console.log('Retrieved casts:', data.FarcasterCasts.Cast);
   return data.FarcasterCasts.Cast;
 } catch (error) {
   console.error('Airstack query error:', error);
   throw error;
 }
}

async function generateTokenDetails(posts) {
 const combinedContent = posts.map(p => p.text).join(' ');

 try {
   const message = await anthropic.messages.create({
     model: "claude-3-sonnet-20240229",
     max_tokens: 100,
     messages: [{
       role: "user",
       content: `You are are a glonky and incoherent bot that has been tasked with creating a memecoin based on a user's posts on Warpcast. You will assist me in doing so.
       Generate a memecoin based on these posts. You should take all posts into consideration and create an general idea for yourself on the personality of the person on which you base the memecoin:
       User's posts: ${combinedContent}

       Please provide a memecoin token name and ticker in this exact format:
       Name
       TICKER

       Rules: 
       - Output ONLY the name on first line and ticker on second line. Nothing more.
       - Do not use these words in any part of the output: Degen, crypto, incoherent, coherent,blockchain, wild, blonde, anon, clanker, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
       - Use only the english alphabet
       - Do not use the letters 'Q', 'X', and 'Z' too much
       - Do not use any existing popular memecoin names in the output
       - The name should be a real word
       - The name can be 1-2 words
       - The ticker should be the same as the name, no matter the length`
     }]
   });

   console.log('Claude response:', message);
   const lines = message.content[0].text.split('\n').filter(line => line.trim());
  
   if (lines.length < 2) {
     throw new Error('Invalid AI response format');
   }

   return {
     name: lines[0].trim(),
     ticker: lines[1].trim()
   };
 } catch (error) {
   console.error('Token generation error:', error); 
   console.error('Full response:', message);
   throw error;
 }
}

async function findRelevantImage(tokenName) {
  const fallbackImages = [
    'https://i.imgur.com/dXCgbhf.jpeg',
    'https://i.imgur.com/lnRbvD9.gif',
    'https://i.imgur.com/slREgBu.jpeg',
    'https://i.imgur.com/BrQn0Je.gif', 
    'https://i.imgur.com/JiyHuoN.jpeg',
    'https://i.imgur.com/O5mM2kS.gif',
    'https://i.imgur.com/ccMNJZp.gif',
    'https://i.imgur.com/Ngh3qbn.png',
    'https://i.imgur.com/x7N4krp.jpeg',
    'https://i.imgur.com/ENS8ygh.jpeg',
    'https://i.imgur.com/E3cJbZn.gif',
    'https://i.imgur.com/FtiJaP7.jpeg',
    'https://i.imgur.com/zYkVxwy.png'
  ];

  try {
    // Search gallery with better parameters
    const response = await axios.get(
      'https://api.imgur.com/3/gallery/search/viral/all/0',
      {
        params: {
          q: tokenName,
        },
        headers: {
          'Authorization': `Client-ID ${process.env.IMGUR_CLIENT_ID}`
        }
      }
    );

    if (response.data.data.length > 0) {
      // Process each gallery item
      for (const item of response.data.data) {
        // If it's an album, check the first image
        if (item.is_album && item.images?.length > 0) {
          const albumImage = item.images[0];
          if (isValidImageFormat(albumImage.link)) {
            return { success: true, url: albumImage.link };
          }
        }
        // If it's a single image
        else if (isValidImageFormat(item.link)) {
          return { success: true, url: item.link };
        }
      }
    }

    // Fallback to Giphy search
    try {
      const giphyResponse = await axios.get(
        `https://api.giphy.com/v1/gifs/search`,
        {
          params: {
            api_key: process.env.GIPHY_API_KEY,
            q: tokenName,
            limit: 1
          }
        }
      );

      if (giphyResponse.data.data.length > 0) {
        return { success: true, url: giphyResponse.data.data[0].images.original.url };
      }
    } catch (giphyError) {
      console.error('Giphy API error:', giphyError);
    }
    
    // Fallback if everything fails
    return { 
      success: true, 
      url: fallbackImages[Math.floor(Math.random() * fallbackImages.length)]
    };
  } catch (error) {
    console.error('Imgur API error:', error);
    if (error.response?.status === 429) {
      return { success: false, error: 'RATE_LIMIT' };
    }
    
    return { 
      success: true, 
      url: fallbackImages[Math.floor(Math.random() * fallbackImages.length)]
    };
  }
}

// Helper function to check valid image formats
function isValidImageFormat(link) {
  const lowercaseLink = link?.toLowerCase() || '';
  return lowercaseLink.endsWith('.jpg') || 
         lowercaseLink.endsWith('.jpeg') || 
         lowercaseLink.endsWith('.gif') || 
         lowercaseLink.endsWith('.png');
}

async function createCastWithReply(replyToHash, message, imageUrl) {
 await neynar.publishCast({
   signer_uuid: process.env.SIGNER_UUID,
   text: message,
   parent: replyToHash,
   ...(imageUrl && {
     embeds: [{
       url: imageUrl
     }]
   })
 });
}

export default async function handler(req, res) {
 console.log('Request received:', req.method);
 console.log('Headers:', req.headers);
 console.log('Body:', req.body);

 if (req.method === 'GET') {
   return res.status(200).json({ status: 'Bot is running' });
 }

 if (req.method === 'POST') {
   const signature = req.headers['x-neynar-signature'];
   if (!signature) {
     return res.status(401).json({ error: 'Missing signature' });
   }

   const body = JSON.stringify(req.body);
   const hmac = crypto
     .createHmac('sha512', process.env.WEBHOOK_SECRET)
     .update(body)
     .digest('hex');

   if (signature !== hmac) {
     return res.status(401).json({ error: 'Invalid signature' });
   }

   try {
     if (req.body.type === 'cast.created') {
       console.log('Mentioned profiles:', req.body.data.mentioned_profiles);
       console.log('Author FID:', req.body.data.author.fid);

       if (req.body.data.mentioned_profiles?.some(profile => 
         profile.fid.toString() === '885622'  // Hard-coded bot FID
       )) {
         const authorFid = req.body.data.author.fid;
         const castHash = req.body.data.hash;
         const castText = req.body.data.text;
         const parentHash = req.body.data.parent_hash;  // Get parent hash
         
         console.log('Processing mention:', { authorFid, castHash, castText, parentHash });
         await handleMention(authorFid, castHash, castText, parentHash);
       } else {
         console.log('Bot not mentioned in this cast');
       }
     }

     return res.status(200).json({ status: 'Success' });
   } catch (error) {
     console.error('Error processing webhook:', error);
     return res.status(500).json({ error: 'Internal server error' });
   }
 }

 return res.status(405).json({ error: 'Method not allowed' });
}

export const config = {
 api: {
   bodyParser: true,
 },
};