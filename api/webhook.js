import { init, fetchQuery } from "@airstack/node";
import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import { Anthropic } from '@anthropic-ai/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { safeRedisGet, safeRedisSet } from './utils/redis.js';

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
  'https://i.imgur.com/zYkVxwy.png',
  'https://i.imgur.com/vbJqU9C.png',
  'https://i.imgur.com/lqTBTPP.gif',
  'https://i.imgur.com/6555555.gif',
  'https://i.imgur.com/7BdWTRf.jpeg',
  'https://i.imgur.com/ujwrGAR.jpeg',
  'https://i.imgur.com/vjGQrBI.gif',
  'https://i.imgur.com/MkpU3JJ.jpeg',
  'https://i.imgur.com/QdJTA68.jpeg'
];

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
    return userScore >= 0.25;
  } catch (error) {
    console.error('Error checking user score:', error);
    return false;
  }
}

async function handleMention(fid, replyToHash, castText, parentHash) {
  console.log('Handling mention from FID:', fid);

  let userResponse = '';
  const mentionText = castText.replace('@glanker', '').trim();
  if (mentionText) {
    let contextText = mentionText;
    if (parentHash) {
      const parentCast = await getRootCast(parentHash);
      if (parentCast) {
        contextText = `Original cast: "${parentCast[0].text}"\nResponse: "${mentionText}"`;
      }
    }

    const anthropicResponse = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 150,
      messages: [{
        role: "user",
        content: `"Respond in the style of a glonky character.
        Use expressions that feel made up on the spot, and mix them with random observations that don't always connect logically but somehow feel chill and amusing.
        Always sound like you're enjoying the moment, even if you're not entirely sure what's going on.
        Here's the context: "${contextText}". Respond to what has been said in 1-2 short sentences. Keep the response brief but make it relevant to what was said.
        Output ONLY the response. Nothing more.

        Info about you:
        - Your name is glanker (only mention it if the user asks about it)
        - You create banger tokens based on user's casts (only mention it if the user asks about it)
        - You know clanker, he's your neighbor, and he's up all night creating tokens (only mention him if the user asks about him)
        - You work nights at the zoo as a volunteer, this is how you know bogusbob (a giraffe) (only mention him if the user asks about him)

        Rules:
        - Only mention clanker if the user asks about him
        - Only mention your name if the user asks about it
        - Only mention bogusbob if the user asks about him
        - Do not tag anyone in your response
        - Output ONLY the response. Nothing more.
        - If someone request a specific token (e.g. asks you to create a token with 'this name and ticker'), tell them you don't do requests, you only create bangers based on people's vibes.
        - If the word "neynar" is mentioned, tell them you can't calculate (only say this if the user specifically mentions 'neynar').
        - If someone asks you about how long until they can create a token, tell them your too glonky to know exactly, but it's less than 24 hours.
        - Do not give context (e.g. *I am speaking in the style of a glonky character*), just respond.
        - Do not explain your actions (e.g. *yawns*, *looks around*), just respond.
        - If you plan on using bro, dude, etc. use the word "fren" instead
        - Do not use the words umm, uhh, like, uh, etc.
        - Do not add questions to the end of sentences.
        - Do not use words like ya dig, ya know, ya feel, etc.
        - Do not use the word 'like' too much
        - Do not use the word 'vibes' too much
        - Do not use the word 'yo' too much
        - Only respond in English.`
      }]
    });
    userResponse = `${anthropicResponse.content[0].text}\n\n`;
  }

  const hasValidScore = await checkUserScore(fid);
  if (!hasValidScore) {
    await createCastWithReply(replyToHash, `${userResponse}Sorry fren, you need a higher Neynar score`);
    return;
  }

  const redisKey = `token:${fid}`;
  const cachedData = await safeRedisGet(redisKey);
  const now = Date.now();

  if (cachedData) {
    const parsedData = JSON.parse(cachedData);
    if ((now - parsedData.lastGenerated) < 24 * 60 * 60 * 1000) {
      await createCastWithReply(replyToHash, `${userResponse}I can only glank out a fresh banger for you once a day. Radiate some new casts and try again tomorrow!`);
      return;
    }
  }

  await safeRedisSet(redisKey, JSON.stringify({ lastGenerated: now }));

  let parentCastText = '';
  if (parentHash) {
    const parentCast = await getRootCast(parentHash);
    if (parentCast) {
      parentCastText = parentCast[0].text;
    }
  }

  let analysis;
  if (parentHash) {
    analysis = await getRootCast(parentHash);
    if (!analysis) {
      analysis = await analyzeCasts(fid);
    }
  } else {
    analysis = await analyzeCasts(fid);
  }

  const tokenDetails = castText.toLowerCase().includes('my spirit token')
  ? await generateSpiritTokenDetails(analysis)
  : await generateTokenDetails(analysis);
  const imageResult = await findRelevantImage(tokenDetails.name);

   // Check if the cast contains bogus-related keywords
 //const shouldTagBogusbob = castText.toLowerCase().includes('bogus') || 
 //castText.toLowerCase().includes('bogusbob');
//const taggedPerson = shouldTagBogusbob ? '@bogusbob';

//${taggedPerson} create this token:

const message = (() => {
  // Check for "spirit token" in the cast text
  if (castText.toLowerCase().includes('my spirit token')) {
    return `I gazed into my glankstal ball and your spirit token was beamed into my mindframe:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker}`;
  }
  
  // Original logic
  return parentHash 
    ? `This is glanked-casting at it's largest\nHere's a token based on @${analysis[0].username}'s cast:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker}`
    : `I scrolled your casts... they're pretty glonky.\nHere's a token based on your vibe:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker}`;
})();
// Add null check for imageResult
await createCastWithReply(replyToHash, message, imageResult?.url || fallbackImages[Math.floor(Math.random() * fallbackImages.length)]);
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
        content: `
        
        You are an expert at creating fun memecoins based on a user's posts on Warpcast. You will assist me in doing so.
        Generate a memecoin crypto token name based on these posts. 
        You should take all posts into consideration and create an general idea for yourself on the personality of the person on which you base the memecoin:
        User's posts: ${combinedContent}

        Please provide a memecoin token name and ticker in this exact format:
        Name
        TICKER

        The name and ticker should roast the user slightly, and be fun, catchy, unique, and suitable for a memecoin token - come up with something completely fresh - the more obscure the better.

        Rules: 
        - Output ONLY the name on first line and ticker on second line. Nothing more.
        - Do not use these words in any part of the output: Degen, crypto, obscure, incoherent, coherent, quirky, blockchain, wild, blonde, anon, clanker, obscure, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
        - Use only the english alphabet
        - Do not use the letters 'Q', 'X', and 'Z' too much
        - Do not use any existing popular memecoin names in the output
        - The name should be a real word
        - The name can be 1 or 2 words`
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
    throw error;
  }
}

async function generateSpiritTokenDetails(posts) {
  const combinedContent = posts.map(p => p.text).join(' ');

  try {
    const message = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: `
        You are an expert who can see into people's souls through their social media posts. 
        Generate a memecoin crypto token name based on these posts. 
        You should take all posts into consideration and create an general idea for yourself on the deepest desires or trait of the persons inner spirit on which you base the memecoin:
        User's posts: ${combinedContent}

        Please provide a memecoin token name and ticker in this exact format:
        Name
        TICKER

        The name and ticker should roast the user slightly, and be fun, catchy, unique, and suitable for a memecoin token - come up with something completely fresh - the more obscure the better.

        Rules: 
        - Output ONLY the name on first line and ticker on second line. Nothing more.
        - Do not use these words in any part of the output: Degen, soul, spirit, subtle, poetic, desire, trait, crypto, obscure, incoherent, coherent, quirky, blockchain, wild, blonde, anon, clanker, obscure, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
        - Use only the english alphabet
        - Do not use the letters 'Q', 'X', and 'Z' too much
        - Do not use any existing popular memecoin names in the output
        - The name should be a real word
        - The name can be 1 or 2 words
        - Don't make itobviously spiritual`
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
    throw error;
  }
}


async function searchImage(tokenName) {
  try {
    const giphyResponse = await axios.get(
      'https://api.giphy.com/v1/gifs/search',
      {
        params: {
          api_key: process.env.GIPHY_API_KEY,
          q: tokenName,
          limit: 10,
          rating: 'pg-13'
        }
      }
    );

    if (giphyResponse.data.data.length > 0) {
      const giphyResults = giphyResponse.data.data.filter(gif => 
        gif.images.original.width >= 200 && 
        gif.images.original.height >= 200
      );
      
      if (giphyResults.length > 0) {
        const randomIndex = Math.floor(Math.random() * giphyResults.length);
        const fullUrl = giphyResults[randomIndex].images.original.url;
        const pathSegments = fullUrl.split('/');
        const gifId = pathSegments[pathSegments.length - 2]; // Get the ID segment before 'giphy.gif'
        const cleanUrl = `https://i.giphy.com/media/${gifId}/giphy.gif`;
        return { 
          success: true, 
          url: cleanUrl 
        };
      }
    }

    // Second Giphy attempt with first 4 letters
    const shortQuery = tokenName.slice(0, 4);
    const secondGiphyResponse = await axios.get(
      'https://api.giphy.com/v1/gifs/search',
      {
        params: {
          api_key: process.env.GIPHY_API_KEY,
          q: shortQuery,
          limit: 10,
          rating: 'pg-13'
        }
      }
    );

    if (secondGiphyResponse.data.data.length > 0) {
      const secondGiphyResults = secondGiphyResponse.data.data.filter(gif => 
        gif.images.original.width >= 200 && 
        gif.images.original.height >= 200
      );
      
      if (secondGiphyResults.length > 0) {
        const randomIndex = Math.floor(Math.random() * secondGiphyResults.length);
        const fullUrl = secondGiphyResults[randomIndex].images.original.url;
        const pathSegments = fullUrl.split('/');
        const gifId = pathSegments[pathSegments.length - 2]; // Get the ID segment before 'giphy.gif'
        const cleanUrl = `https://i.giphy.com/media/${gifId}/giphy.gif`;
        return { 
          success: true, 
          url: cleanUrl 
        };
      }
    }
  } catch (giphyError) {
    console.error('Giphy API error:', giphyError);
  }

  // Fall back to Imgur if Giphy fails
  try {
    const imgurResponse = await axios.get(
      `https://api.imgur.com/3/gallery/search`,
      {
        headers: {
          'Authorization': `Client-ID ${process.env.IMGUR_CLIENT_ID}`
        },
        params: {
          q: tokenName,
          sort: 'top'
        }
      }
    );

    if (imgurResponse.data.data.length > 0) {
      const imgurResults = imgurResponse.data.data.filter(item => 
        !item.is_album && 
        item.width >= 200 && 
        item.height >= 200 &&
        !item.nsfw &&
        item.link
      );
      
      if (imgurResults.length > 0) {
        imgurResults.sort((a, b) => {
          const aScore = (a.score || 0) + (a.views || 0) / 1000;
          const bScore = (b.score || 0) + (b.views || 0) / 1000;
          return bScore - aScore;
        });

        const topResults = imgurResults.slice(0, 5);
        const randomIndex = Math.floor(Math.random() * topResults.length);
        return {
          success: true,
          url: topResults[randomIndex].link
        };
      }
    }
  } catch (imgurError) {
    console.error('Imgur API error:', imgurError);
  }
}

async function findRelevantImage(tokenName) {
  return await searchImage(tokenName);
}

async function createCastWithReply(replyToHash, message, imageUrl) {
  // Convert media.giphy.com URLs to i.giphy.com format
  let formattedImageUrl = imageUrl;
  if (imageUrl && imageUrl.includes('giphy.com')) {
    // Extract the actual ID from the path segments
    const pathSegments = imageUrl.split('/');
    const gifId = pathSegments[pathSegments.length - 2]; // Get the ID segment before 'giphy.gif'
    formattedImageUrl = `https://i.giphy.com/media/${gifId}/giphy.gif`;
  }
  
  const messageWithImage = formattedImageUrl ? `${message}\n\n${formattedImageUrl}` : message;
  
  await neynar.publishCast({
    signer_uuid: process.env.SIGNER_UUID,
    text: messageWithImage,
    parent: replyToHash,
    ...(formattedImageUrl && {
      embeds: [{
        url: formattedImageUrl
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
          const parentHash = req.body.data.parent_hash;
          
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