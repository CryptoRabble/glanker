import { init, fetchQuery } from "@airstack/node";
import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import { Anthropic } from '@anthropic-ai/sdk';
import axios from 'axios';
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
      fid: response.cast.author.fid
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
   return userScore >= 0.15;
 } catch (error) {
   console.error('Error checking user score:', error);
   return false;
 }
}

async function handleMention(fid, replyToHash, castText, parentHash) {
 console.log('Handling mention from FID:', fid);

 // Get parent cast content first if it exists
 let parentCastText = '';
 if (parentHash) {
   const parentCast = await getRootCast(parentHash);
   if (parentCast) {
     parentCastText = parentCast[0].text;
   }
 }

 // Generate response to user text
 let userResponse = '';
 const mentionText = castText.replace('@glanker', '').trim();
 if (mentionText) {
   const anthropicResponse = await anthropic.messages.create({
     model: "claude-3-sonnet-20240229",
     max_tokens: 150,
     messages: [{
       role: "user",
       content: `You are glonky and your speech is barely coherent. ${
         parentCastText 
           ? `Someone has posted: "${parentCastText}" and someone else replied asking: "${mentionText}".`
           : `Someone has said: "${mentionText}".`
       } Respond to what they said in 1-2 sentences. Keep the response brief but make it relevant to what they said. Here is an example of how you should sound: 
       "Bruh... like... the air's, uh... heavy? But also, like... floatin'? And my... my feet, ... they're on the ground but, like, not really? Whoa, did you hear that? The grass is... humming."
       Output ONLY the response. Nothing more.`
     }]
   });
   userResponse = `${anthropicResponse.content[0].text}\n\n`;
 }

 // Check rate limit 
 const cachedData = tokenCache.get(fid);
 const now = Date.now();

 if (cachedData && (now - cachedData.lastGenerated) < 24 * 60 * 60 * 1000) {
   await createCastWithReply(replyToHash, `${userResponse}\nDaily limit reached. Come back tomorrow!`);
   return;
 }

 // Check user score before proceeding
 const hasValidScore = await checkUserScore(fid);
 if (!hasValidScore) {
   await createCastWithReply(replyToHash, `${userResponse}\nSorry fren, you need a higher Neynar score to create tokens`, 
     "https://warpcast.com/rish/0x458f80e4" 
   );
   return;
 }



 // Get either root cast or user's casts
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

 if (!imageResult.success) {
   await createCastWithReply(replyToHash, `${userResponse}\nUh, I can only handle so much. Try again in an hour!`);
   return;
 }

 tokenCache.set(fid, { lastGenerated: now });

 const message = parentHash 
 ? `${userResponse}Yo, this cast is spacey... here's a token based on it:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker}`
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
       NAME
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
  try {
    const response = await axios.get(
      'https://api.imgur.com/3/gallery/search',
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
      // Find first item that has a link ending in jpg, jpeg, or png (case insensitive)
      const image = response.data.data.find(item => {
        const link = item.link?.toLowerCase() || '';
        return link.endsWith('.jpg') || 
               link.endsWith('.jpeg') || 
               link.endsWith('.gif') || 
               link.endsWith('.png');
      });
      if (image) {
        return { success: true, url: image.link };
      }
    }
    return { 
      success: true, 
      url: 'https://i.imgur.com/aptQBum.jpeg' // Default fallback image
    };
  } catch (error) {
    console.error('Imgur API error:', error);
    if (error.response?.status === 429) {
      return { success: false, error: 'RATE_LIMIT' };
    }
    return { 
      success: true, 
      url: 'https://i.imgur.com/aptQBum.jpeg' // Default fallback image
    };
  }
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