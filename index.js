const { AirstackClient } = require('@airstack/node');
const { NeynarAPIClient } = require('@neynar/nodejs-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');
const NodeCache = require('node-cache');

// Initialize clients and cache
const airstack = new AirstackClient('AIRSTACK_API_KEY');
const neynar = new NeynarAPIClient('NEYNAR_API_KEY');
const IMGUR_CLIENT_ID = 'YOUR_IMGUR_CLIENT_ID';
const anthropic = new Anthropic({
  apiKey: 'ANTHROPIC_API_KEY'
});
const UNSPLASH_ACCESS_KEY = 'UNSPLASH_KEY';
const SIGNER_UUID = 'SIGNER_UUID';
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
      const response = await axios.get('https://api.imgur.com/3/gallery/search', {
        headers: { 
          Authorization: `Client-ID ${IMGUR_CLIENT_ID}`
        },
        params: {
          q: tokenName,
          q_type: 'jpg|png'
        }
      });
      
      // Filter for non-animated images
      const images = response.data.data.filter(item => 
        !item.is_album && 
        !item.animated && 
        !item.nsfw && 
        item.type && 
        (item.type.endsWith('/jpeg') || item.type.endsWith('/png'))
      );
  
      // Get random image from first 10 results (or less if fewer results)
      const maxIndex = Math.min(images.length, 10);
      const randomIndex = Math.floor(Math.random() * maxIndex);
      return images[randomIndex].link;
    } catch (error) {
      console.error('Imgur API error:', error);
      // Fallback to a default image if Imgur fails
      return 'DEFAULT_IMAGE_URL';
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

app.post('/webhook', async (req, res) => {
  try {
    const { username, castHash } = req.body;
    await handleMention(username, castHash);
    res.status(200).send('Success');
  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('Error processing request');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));