const { AirstackClient } = require('@airstack/node');
const { NeynarAPIClient } = require('@neynar/nodejs-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');
const NodeCache = require('node-cache');
const express = require('express');
const crypto = require('crypto');

// Initialize clients and cache
const airstack = new AirstackClient(process.env.AIRSTACK_API_KEY);
const neynar = new NeynarAPIClient(process.env.NEYNAR_API_KEY);
const WEBHOOK_SECRET = 'kDsKrepcx6b2FQM0DxOVBBexv';
const PINTEREST_ACCESS_TOKEN = process.env.PINTEREST_API_KEY;
const anthropic = new Anthropic({
 apiKey: process.env.ANTHROPIC_API_KEY
});
const SIGNER_UUID = process.env.SIGNER_UUID;
const tokenCache = new NodeCache();

async function handleMention(fid, replyToHash) {
 console.log('Handling mention from FID:', fid);
 const cachedData = tokenCache.get(fid);
 const now = Date.now();
 
 if (cachedData) {
   const timeSinceLastGeneration = now - cachedData.lastGenerated;
   if (timeSinceLastGeneration < 24 * 60 * 60 * 1000) {
     await createCastWithReply(replyToHash, "Daily limit reached");
     return;
   }
 }

 const analysis = await analyzeCasts(fid);
 const tokenDetails = await generateTokenDetails(analysis);
 const imageUrl = await findRelevantImage(tokenDetails.name);
 const imageBuffer = await downloadImage(imageUrl);
 const uploadedImageUrl = await uploadImageToFarcaster(imageBuffer);

 tokenCache.set(fid, { lastGenerated: now });

 await createCastWithImage(
   tokenDetails.name,
   tokenDetails.ticker,
   uploadedImageUrl,
   replyToHash
 );
}

async function analyzeCasts(fid) {
 console.log('Analyzing casts for FID:', fid);
 const query = `
   query GetUserCasts {
     FarcasterCasts(
       input: {filter: {castedBy: {_eq: "${fid}"}}, blockchain: ALL, limit: 25}
     ) {
       Cast {
         text
         timestamp
       }
     }
   }
 `;
 
 try {
   const { data } = await airstack.query(query);
   console.log('Retrieved casts:', data.FarcasterCasts.Cast);
   return data.FarcasterCasts.Cast;
 } catch (error) {
   console.error('Airstack query error:', error);
   throw new Error('Failed to fetch user casts');
 }
}

async function generateTokenDetails(posts) {
 try {
   const combinedContent = posts.map(p => p.text).join(' ');
   
   const message = await anthropic.messages.create({
     model: "claude-3-sonnet-20240229",
     max_tokens: 100,
     messages: [{
       role: "user",
       content: `You are an expert at creating a memecoin based on a user's posts on Warpcast. You will assist me in doing so.
       Generate a memecoin based on these posts. You should take all posts into consideration and create an general idea for yourself on the personality of the person on which you base the memecoin:
       User's posts: ${combinedContent}

       Please provide a memecoin token name and ticker in this exact format:
       NAME
       TICKER

       Rules: 
       - Output ONLY the name on first line and ticker on second line. Nothing more.
       - Do not use these words in any part of the output: Degen, wild, clanker, base, based, glonk, glonky bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
       - Use only the english alphabet
       - Do not use the letters 'Q', 'X', and 'Z' too much
       - Do not use any existing popular memecoin names in the output
       - The name should be a real word`
     }]
   });

   const lines = message.content.split('\n').filter(line => line.trim());
   console.log('Generated token details:', lines);
   
   if (lines.length < 2) {
     throw new Error('Invalid AI response format');
   }

   return {
     name: lines[0].trim(),
     ticker: lines[1].trim()
   };
 } catch (error) {
   console.error('Token generation error:', error);
   throw new Error('Failed to generate token details');
 }
}

async function findRelevantImage(tokenName) {
 try {
   const response = await axios.get(
     'https://api.pinterest.com/v5/pins/search',
     {
       params: {
         query: tokenName,
         page_size: 10,
         media_type: 'image'
       },
       headers: {
         'Authorization': `Bearer ${PINTEREST_ACCESS_TOKEN}`
       }
     }
   );

   if (!response.data?.items?.length) {
     throw new Error('No Pinterest results found');
   }

   const validImages = response.data.items
     .filter(item => {
       const hasValidImage = item.media?.images?.original?.url || 
                           item.image?.original?.url;
       return hasValidImage;
     })
     .map(item => item.media?.images?.original?.url || 
                 item.image?.original?.url);

   if (!validImages.length) {
     throw new Error('No valid images found');
   }

   const selectedImage = validImages[Math.floor(Math.random() * validImages.length)];
   console.log('Selected image URL:', selectedImage);
   return selectedImage;

 } catch (error) {
   console.error('Pinterest API error:', error);
   return 'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/36b28dd1-3616-4205-2869-0f07ec467200/original';
 }
}

async function downloadImage(imageUrl) {
 try {
   const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
   return Buffer.from(response.data);
 } catch (error) {
   console.error('Image download error:', error);
   throw new Error('Failed to download image');
 }
}

async function uploadImageToFarcaster(imageBuffer) {
 try {
   const formData = new FormData();
   formData.append('file', imageBuffer, {
     filename: 'token-image.jpg',
     contentType: 'image/jpeg',
   });

   const response = await neynar.publishCast.uploadImage(SIGNER_UUID, formData);
   console.log('Image uploaded to Farcaster:', response.url);
   return response.url;
 } catch (error) {
   console.error('Farcaster upload error:', error);
   throw new Error('Failed to upload image to Farcaster');
 }
}

async function createCastWithImage(name, ticker, imageUrl, replyToHash) {
 try {
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
   console.log('Cast created successfully');
 } catch (error) {
   console.error('Cast creation error:', error);
   throw new Error('Failed to create cast');
 }
}

async function createCastWithReply(replyToHash, message) {
 try {
   await neynar.publishCast.cast(
     SIGNER_UUID,
     message,
     {
       replyTo: replyToHash
     }
   );
   console.log('Reply cast created successfully');
 } catch (error) {
   console.error('Reply creation error:', error);
   throw new Error('Failed to create reply');
 }
}

const app = express();
app.use(express.json());

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

app.get('/', (req, res) => {
 console.log('Health check received');
 res.status(200).send('Bot is running');
});

app.post('/', verifyWebhookSignature, async (req, res) => {
 console.log('Webhook received:', JSON.stringify(req.body, null, 2));
 try {
   const eventData = req.body;
   console.log('Event data:', eventData);
   
   if (eventData.type === 'cast.created') {
     const fid = eventData.data.fid;
     const castHash = eventData.data.hash;
     console.log('Processing mention from FID:', fid);
     await handleMention(fid, castHash);
   }
   
   res.status(200).send('Success');
 } catch (error) {
   console.error('Webhook processing error:', error);
   res.status(500).send('Error processing webhook');
 }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));