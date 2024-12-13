import { init, fetchQuery } from "@airstack/node";
import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import { Anthropic } from '@anthropic-ai/sdk';
import axios from 'axios';
import crypto from 'crypto';
import { safeRedisGet, safeRedisSet } from './utils/redis.js';
import { analyzeImage } from './utils/imageAnalyzer.js';

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

async function getFirstChildCast(parentHash) {
  try {
    const response = await neynar.fetchCastsByParent({
      parentHash: parentHash,
      limit: 1
    });
    
    if (response.casts && response.casts.length > 0) {
      return response.casts[0];
    }
    return null;
  } catch (error) {
    console.error('Error fetching child cast:', error);
    return null;
  }
}

async function handleMention(fid, replyToHash, castText, parentHash, mentionedProfiles, castData) {
  try {
    console.log('Handling mention from FID:', fid);

    const isPfpRequest = castText.toLowerCase().includes('my pfp') || 
                        castText.toLowerCase().includes('my profile pic') ||
                        castText.toLowerCase().includes('my profile picture') ||
                        castText.toLowerCase().includes('my profile image');
    
    // Add PFP check early in the function
    if (isPfpRequest) {
      const username = castData.author.username;
      const pfpKey = `${username}:pfp`;
      const existingPfp = await safeRedisGet(pfpKey);
      
      if (existingPfp) {
        console.log('User already has PFP token:', existingPfp);
        await createCastWithReply(replyToHash, "You can only create one pfp token atm fren, need to keep that rarity high.\n\nHit up my gloinked creator DiviFlyy if you need a fresh one!");
        return;
      }
    }

    // Check if user is asking about an image but didn't include one
    // Exclude cases where they're asking about their profile picture
    const isAskingAboutImage = !isPfpRequest && (
        castText.toLowerCase().includes('image') || 
        castText.toLowerCase().includes('picture')
    );

    // Get tagged users from mentioned_profiles (excluding glanker)
    const taggedUsers = mentionedProfiles.filter(profile => 
      profile.fid.toString() !== '885622' // Exclude glanker's FID 885622
    );

    let targetFid = fid;
    let targetUsername = null;

    if (taggedUsers.length > 0) {
      console.log('Found tagged users:', taggedUsers);
      const taggedUser = taggedUsers[0];
      targetFid = taggedUser.fid;
      targetUsername = taggedUser.username;
    }

    let userResponse = '';
    const mentionText = castText.replace('@glanker', '').trim();
    console.log('Mention text:', mentionText);
    
    if (mentionText) {
      console.log('Processing mention text');
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
    console.log('Score check result:', hasValidScore);
    
    if (!hasValidScore) {
      console.log('Invalid score, sending response');
      await createCastWithReply(replyToHash, `${userResponse}Sorry fren, you need a higher Neynar score`);
      return;
    }

    // Only check daily limit if it's NOT a PFP request
    if (!isPfpRequest) {
      const redisKey = `token:${fid}`;
      const cachedData = await safeRedisGet(redisKey);
      const now = Date.now();
      console.log('Redis data:', cachedData);

      if (cachedData) {
        const parsedData = JSON.parse(cachedData);
        console.log('Time since last generation:', now - parsedData.lastGenerated);
        if ((now - parsedData.lastGenerated) < 24 * 60 * 60 * 1000) {
          console.log('Too soon, sending cooldown message');
          await createCastWithReply(replyToHash, `${userResponse}I can only glank out a fresh banger for you once a day. Radiate some new casts and try again tomorrow!`);
          return;
        }
      }

      console.log('Proceeding with token generation');
      await safeRedisSet(redisKey, JSON.stringify({ lastGenerated: now }));
    }

    let tokenDetails;
    let message;
    let outputImage;
    
    console.log('Checking for image embeds in cast data:', castData.embeds);
    let hasImageEmbed = castData.embeds?.some(embed => 
      embed.metadata?.content_type?.startsWith('image/') || 
      (embed.url && (
        embed.url.includes('imagedelivery.net') ||
        embed.url.endsWith('.jpg') || 
        embed.url.endsWith('.jpeg') || 
        embed.url.endsWith('.png') || 
        embed.url.endsWith('.gif')
      ))
    );
    console.log('Has image embed:', hasImageEmbed);

    // If it's a profile picture request, check Redis first
    if (isPfpRequest) {
      console.log('Processing profile picture request');
      const pfpUrl = castData.author.pfp_url;
      const username = castData.author.username;
      console.log('Found profile picture:', pfpUrl);
      
      if (pfpUrl) {
        hasImageEmbed = true;
        castData = {
          embeds: [{
            url: pfpUrl,
            metadata: {
              content_type: 'image/jpeg'
            }
          }]
        };

        // Store PFP request in Redis permanently (no expiration)
        const castUrl = `https://warpcast.com/${username}/${replyToHash}`;
        await safeRedisSet(`${username}:pfp`, JSON.stringify({
          castUrl: castUrl,
          hash: replyToHash,
          timestamp: Date.now()
        }));
      } else {
        await createCastWithReply(replyToHash, "Sorry fren, I couldn't find your profile picture!");
        return;
      }
    }

    // If asking about image but no image in current cast, check parent
    if (isAskingAboutImage && !hasImageEmbed && parentHash) {
      console.log('User mentioned image but none found, checking parent cast');
      const parentCast = await neynar.lookupCastByHashOrWarpcastUrl({
        type: 'hash',
        identifier: parentHash
      });
      
      if (parentCast.cast.embeds?.length > 0) {
        console.log('Found image in parent cast');
        castData = parentCast.cast;
        hasImageEmbed = true;
      }
    }

    if (hasImageEmbed) {
      console.log('Found image embed in cast');
      // Get image embed URL
      const imageEmbed = castData.embeds.find(embed => 
        embed.metadata?.content_type?.startsWith('image/') ||
        (embed.url && (
          embed.url.includes('imagedelivery.net') ||
          embed.url.endsWith('.jpg') || 
          embed.url.endsWith('.jpeg') || 
          embed.url.endsWith('.png') || 
          embed.url.endsWith('.gif')
        ))
      );
      outputImage = imageEmbed.url;

      console.log('Processing image:', outputImage);
      
      // Try to generate token from image
      const imageData = {
        embeds: [{
          url: outputImage,
          metadata: {
            content_type: 'image/jpeg'  // Default to jpeg for pending metadata
          }
        }]
      };
      console.log('Sending to analyzeImage:', imageData);
      
      const imageTokenDetails = await analyzeImage(imageData);
      console.log('Image analysis result:', imageTokenDetails);
      
      if (imageTokenDetails) {
        tokenDetails = imageTokenDetails;
        message = isPfpRequest 
          ? `Woah fren, that's one glankster pfp!\nI'll immortalize it as a clanker token:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
          : `That is one glonkerized image fren\nHere's a token based on it:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`;
      } else {
        // Fallback to text-based generation if image analysis fails
        let analysis;
        if (parentHash) {
          analysis = await getRootCast(parentHash);
          if (!analysis) {
            analysis = await analyzeCasts(targetFid);
          }
        } else {
          analysis = await analyzeCasts(targetFid);
        }
        tokenDetails = await generateTokenDetails(analysis);
        const imageResult = await findRelevantImage(tokenDetails.name);
        outputImage = imageResult?.url || fallbackImages[Math.floor(Math.random() * fallbackImages.length)];
        message = targetUsername
          ? `Ah, you want me to peep on other people's profiles?\nAlright fren, here's a token based on @${targetUsername}'s vibe:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
          : `${userResponse}I scrolled through your casts... they're pretty glonky.\nHere's a token based on your vibe:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`;
      }
    } else {
      // No image, use text-based generation
      let analysis;
      if (parentHash) {
        analysis = await getRootCast(parentHash);
        if (!analysis) {
          analysis = await analyzeCasts(targetFid);
        }
      } else {
        analysis = await analyzeCasts(targetFid);
      }
      tokenDetails = await generateTokenDetails(analysis);
      const imageResult = await findRelevantImage(tokenDetails.name);
      outputImage = imageResult?.url || fallbackImages[Math.floor(Math.random() * fallbackImages.length)];
      message = targetUsername
        ? `Ah, you want me to peep on other people's profiles?\nAlright fren, here's a token based on @${targetUsername}'s vibe:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
        : `${userResponse}I scrolled through your casts... they're pretty glonky.\nHere's a token based on your vibe:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`;
    }

    await createCastWithReply(replyToHash, message, outputImage);
  } catch (error) {
    console.error('Error in handleMention:', error);
    // Attempt to notify the user of the error
    try {
      await createCastWithReply(replyToHash, "Sorry fren, something went wrong while processing your request!");
    } catch (replyError) {
      console.error('Error sending error message:', replyError);
    }
  }
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
        Generate a meme token name and ticker based on this user's posts. 
        You should take all posts into consideration and create an general idea for yourself on the personality of the person on which you base the token:
        User's posts: ${combinedContent}

        Please provide a token name and ticker. The name should roast the user slightly, and be fun, catchy, unique, and suitable for a meme token - come up with something completely fresh - the more obscure the better.

        Rules: 
        - Output only the name and ticker, each on a separate line. Nothing more.
        - Do not use these words in any part of the output: Degen, crypto, obscure, incoherent, coherent, quirky, blockchain, wild, blonde, anon, clanker, obscure, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
        - Use only the english alphabet
        - Do not use the letters 'Q', 'X', and 'Z' too much
        - Do not use any existing popular memecoin names in the output
        - The name should be a real word
        - The name can be 1 or 2 words
        - The ticker should be the same as the name if the name is between 3-10 characters`
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

// Keep the generateSpiritTokenDetails function but comment it out
/*
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

        lease provide a memecoin token name and ticker. The name should roast the user slightly, and be fun, catchy, unique, and suitable for a memecoin token - come up with something completely fresh - the more obscure the better.

        Rules: 
        - Output ONLY the name on first line and ticker on second line. Nothing more.
        - Do not use these words in any part of the output: Degen, soul, spirit, subtle, poetic, desire, trait, crypto, obscure, incoherent, coherent, quirky, blockchain, wild, blonde, anon, clanker, obscure, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
        - Use only the english alphabet
        - Do not use the letters 'Q', 'X', and 'Z' too much
        - Do not use any existing popular memecoin names in the output
        - The name should be a real word
        - The name can be 1 or 2 words
        - The ticker should be between 3-10 characters
        - Don't make it obviously spiritual`
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
*/

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
      const giphyResults = giphyResponse.data.data.filter(gif => {
        const width = parseInt(gif.images.original.width);
        const height = parseInt(gif.images.original.height);
        const aspectRatio = width / height;
        return width >= 200 && 
               height >= 200 && 
               aspectRatio <= 1.91 &&    // Not wider than 2:1
               aspectRatio >= 0.67;   // Not taller than 1:1.5
      });
      
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
      const secondGiphyResults = secondGiphyResponse.data.data.filter(gif => {
        const width = parseInt(gif.images.original.width);
        const height = parseInt(gif.images.original.height);
        const aspectRatio = width / height;
        return width >= 200 && 
               height >= 200 && 
               aspectRatio <= 1.91 &&    // Not wider than 2:1
               aspectRatio >= 0.67;   // Not taller than 1:1.5
      });
      
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
  try {
    console.log('Creating cast reply with:', {
      replyToHash,
      message,
      imageUrl
    });
    
    // Convert media.giphy.com URLs to i.giphy.com format
    let formattedImageUrl = imageUrl;
    if (imageUrl && imageUrl.includes('giphy.com')) {
      console.log('Formatting Giphy URL');
      const pathSegments = imageUrl.split('/');
      const gifId = pathSegments[pathSegments.length - 2];
      formattedImageUrl = `https://i.giphy.com/media/${gifId}/giphy.gif`;
    }
    
    const messageWithImage = formattedImageUrl ? `${message}\n\n${formattedImageUrl}` : message;
    console.log('Final message:', messageWithImage);
    
    console.log('Calling neynar.publishCast with:', {
      signer_uuid: process.env.SIGNER_UUID ? '[PRESENT]' : '[MISSING]',
      text: messageWithImage,
      parent: replyToHash,
      embeds: formattedImageUrl ? [{ url: formattedImageUrl }] : undefined
    });

    const response = await neynar.publishCast({
      signer_uuid: process.env.SIGNER_UUID,
      text: messageWithImage,
      parent: replyToHash,
      ...(formattedImageUrl && {
        embeds: [{
          url: formattedImageUrl
        }]
      })
    });
    
    console.log('Cast published successfully:', response);
  } catch (error) {
    console.error('Error in createCastWithReply:', error);
    throw error; // Re-throw to be caught by the parent try-catch
  }
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
          const mentionedProfiles = req.body.data.mentioned_profiles;
          
          console.log('Processing mention:', { authorFid, castHash, castText, parentHash });
          await handleMention(
            authorFid, 
            castHash, 
            castText, 
            parentHash, 
            mentionedProfiles,
            req.body.data  // Pass the cast data
          ); 
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