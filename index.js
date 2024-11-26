const { AirstackClient } = require('@airstack/node');
const { NeynarAPIClient } = require('@neynar/nodejs-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');
const NodeCache = require('node-cache');


// Initialize clients and cache
const airstack = new AirstackClient(process.env.AIRSTACK_API_KEY);
const crypto = require('crypto');
const WEBHOOK_SECRET = 'kDsKrepcx6b2FQM0DxOVBBexv'; // The secret you set in Neynar
const neynar = new NeynarAPIClient(process.env.NEYNAR_API_KEY);
const PINTEREST_ACCESS_TOKEN = process.env.PINTEREST_API_KEY;
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});
const SIGNER_UUID = process.env.SIGNER_UUID;
const tokenCache = new NodeCache();

async function handleMention(username, replyToHash) {
  const cachedData = tokenCache.get(username);
  const now = Date.now();
  
  if (cachedData) {
    const timeSinceLastGeneration = now - cachedData.lastGenerated;
    if (timeSinceLastGeneration < 24 * 60 * 60 * 1000) {
      await createCastWithReply(replyToHash, "I'm wayy toe glonky to create another tkn freind - cast some more castss and try again tomoroww");
      return;
    }
  }

  const analysis = await analyzeCasts(username);
  const tokenDetails = await generateTokenDetails(analysis);
  const imageUrl = await findRelevantImage(tokenDetails.name);
  const imageBuffer = await downloadImage(imageUrl);
  const uploadedImageUrl = await uploadImageToFarcaster(imageBuffer);

  tokenCache.set(username, { lastGenerated: now });

  await createCastWithImage(
    tokenDetails.name,
    tokenDetails.ticker,
    uploadedImageUrl,
    replyToHash
  );
}

async function analyzeCasts(username) {
    const query = `
      query GetUserCasts($username: String!) {
        FarcasterCasts(
          input: {filter: {castedBy: {_eq: "fc_fid:${username}"}}, blockchain: ALL, limit: 25}
        ) {
          Cast {
            text
            timestamp
          }
        }
      }
    `;
    
    const { data } = await airstack.query(query, { username });
    return data.FarcasterCasts.Cast;
  }
  

async function generateTokenDetails(posts) {
  const combinedContent = posts.map(p => p.content).join(' ');
  
  const message = await anthropic.messages.create({
    model: "claude-3-sonnet-20240229",
    max_tokens: 100,
    messages: [{
      role: "user",
      content: `You are an expert at creating a memecoin based on a user's posts on Warpcast. You will assist me in doing so.
     Generate a memecoin based on these posts. You should take all posts into consideration and create an general idea for yourself on the personality of the person on which you base the memecoin:
      User's posts: ${combinedContent}

      Please provide a memecoin token name and ticker.
      The name should be based and a bit glonky - come up with something completely fresh - the more obscure the better.
      
      Rules: 
      - Output only the name and ticker each on a separate line. Nothing more.
      - Do not use these words in any part of the output: Degen, wild, clanker, base, based, glonk, glonky bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
      - Use only the english alphabet
      - Do not use the letters 'Q', 'X', and 'Z' too much
      - Do not use any existing popular memecoin names in the output
      - The name should be a real word`
    }]
  });
  
  const [name, ticker] = message.content.split('|');
  return { name: name.trim(), ticker: ticker.trim() };
}

// Rest of the code remains the same
async function findRelevantImage(tokenName) {
    try {
      const response = await axios.get(
        'https://api.pinterest.com/v5/pins/search',
        {
          params: {
            query: tokenName,  // Just using the token name
            page_size: 10,
            media_type: 'image'
          },
          headers: {
            'Authorization': `Bearer ${PINTEREST_ACCESS_TOKEN}`
          }
        }
      );

      // Add error checking for response structure
      if (!response.data || !response.data.items || response.data.items.length === 0) {
        throw new Error('No Pinterest results found');
      }

      // Filter valid images and handle different response structures
      const images = response.data.items.filter(item => {
        return item.media && 
               ((item.media.images && item.media.images.original) || 
                (item.image && item.image.original));
      });

      if (images.length === 0) {
        throw new Error('No suitable images found');
      }

      const randomImage = images[Math.floor(Math.random() * images.length)];
      const imageUrl = randomImage.media?.images?.original?.url || 
                      randomImage.image?.original?.url;

      if (!imageUrl) {
        throw new Error('Invalid image URL structure');
      }

      return imageUrl;
    } catch (error) {
      console.error('Pinterest API error:', error);
      return 'https://your-actual-fallback-image-url.jpg';
    }
  }

async function downloadImage(imageUrl) {
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

async function uploadImageToFarcaster(imageBuffer) {
  const formData = new FormData();
  formData.append('file', imageBuffer, {
    filename: 'token-image.jpg',
    contentType: 'image/jpeg',
  });

  const response = await neynar.publishCast.uploadImage(SIGNER_UUID, formData);
  return response.url;
}

async function createCastWithImage(name, ticker, imageUrl, replyToHash) {
  const castText = `I've analyzed your posts and came up with this token based on your vibess.
  
  @clanker create this token:\nName: ${name}\nTicker: $${ticker}\nImage:`;
  
  await neynar.publishCast.cast(
    SIGNER_UUID,
    castText,
    {
      replyTo: replyToHash,
      embeds: [{
        url: imageUrl
      }]
    }
  );
}

async function createCastWithReply(replyToHash, message) {
  await neynar.publishCast.cast(
    SIGNER_UUID,
    message,
    {
      replyTo: replyToHash
    }
  );
}

const express = require('express');
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
    console.log('Root path hit');
    res.status(200).send('Bot is running');
  });

// Webhook verification middleware
function verifyWebhookSignature(req, res, next) {
    const signature = req.headers['x-neynar-signature'];
    const body = JSON.stringify(req.body);
    
    const hmac = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(body)
      .digest('hex');
      
    if (signature === hmac) {
      next();
    } else {
      res.status(401).send('Invalid signature');
    }
  }
  
  app.post('/webhook', verifyWebhookSignature, async (req, res) => {
    console.log('Webhook received:', JSON.stringify(req.body, null, 2));
    try {
      const eventData = req.body;
      // Log the full event data
      console.log('Event data:', eventData);
      
      if (eventData.type === 'cast.created') {
        const username = eventData.data.username;
        const castHash = eventData.data.hash;
        console.log('Processing mention from:', username);
        await handleMention(username, castHash);
      }
      
      res.status(200).send('Success');
    } catch (error) {
      console.error('Error:', error);
      res.status(500).send('Error processing webhook');
    }
  });
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));