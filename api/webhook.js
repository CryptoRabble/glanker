import { init, fetchQuery } from "@airstack/node";
import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import { Anthropic } from '@anthropic-ai/sdk';
import axios from 'axios';
import FormData from 'form-data';
import crypto from 'crypto';

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

// In-memory cache for rate limiting
const tokenCache = new Map();

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
 return {
   name: lines[0].trim(),
   ticker: lines[1].trim()
 };
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
         'Authorization': `Bearer ${process.env.PINTEREST_API_KEY}`
       }
     }
   );

   if (!response.data?.items?.length) {
     throw new Error('No Pinterest results found');
   }

   const validImages = response.data.items
     .filter(item => item.media?.images?.original?.url || item.image?.original?.url)
     .map(item => item.media?.images?.original?.url || item.image?.original?.url);

   if (!validImages.length) {
     throw new Error('No valid images found');
   }

   return validImages[Math.floor(Math.random() * validImages.length)];
 } catch (error) {
   return 'https://imagedelivery.net/BXluQx4ige9GuW0Ia56BHw/36b28dd1-3616-4205-2869-0f07ec467200/original';
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

 const response = await neynar.publishCast.uploadImage(process.env.SIGNER_UUID, formData);
 return response.url;
}

async function createCastWithImage(name, ticker, imageUrl, replyToHash) {
 const castText = `I've analyzed your posts and came up with this token based on your vibess.
 
 @clanker create this token:\nName: ${name}\nTicker: $${ticker}\nImage:`;
 
 await neynar.publishCast.cast(
   process.env.SIGNER_UUID,
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
   process.env.SIGNER_UUID,
   message,
   {
     replyTo: replyToHash
   }
 );
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
     if (req.body.type === 'cast.created' && 
         req.body.data.mentioned_profiles?.some(profile => profile.fid === process.env.BOT_FID)) {
       
       const authorFid = req.body.data.author.fid;
       const castHash = req.body.data.hash;
       
       await handleMention(authorFid, castHash);
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