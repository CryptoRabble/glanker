import { init } from "@airstack/node";
import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import { Anthropic } from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { safeRedisGet, safeRedisSet, safeRedisDel } from './utils/redis.js';
import { getRootCast, checkUserScore, isReferringToParentCast } from './utils/castUtils.js';
import { analyzeImage } from './utils/imageAnalyzer.js';
import { isAuthorizedCommenter } from './utils/authChecker.js';
import { findRelevantImage } from './utils/imageSearch.js';
import { analyzeCasts, generateTokenDetails } from './utils/tokenGenerator.js';
import { ethers } from 'ethers'
import { LP_ABI } from './utils/lpabi.js';
const LP_CONTRACT_ADDRESS = '0x503e881ace7b46f99168964aa7a484d87926bb17'


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
export { neynar }; 

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});
export { anthropic };

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

async function handleMention(fid, replyToHash, castText, parentHash, mentionedProfiles, castData, positionId, tokenAddress) {
  try {
    console.log('Handling mention from FID:', fid);
    console.log('Position ID:', positionId);
    console.log('Token Address:', tokenAddress);

    // If we have a position ID and it's from Clanker (FID 874542), only handle the token transfer
    if (positionId && tokenAddress && fid.toString() === '874542') {
      try {
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const lpContract = new ethers.Contract(LP_CONTRACT_ADDRESS, LP_ABI, signer);
        
        // Get parent cast (the one your bot replied to)
        const parentCast = await neynar.lookupCastByHashOrWarpcastUrl({
          type: 'hash',
          identifier: parentHash
        });

        if (!parentCast || !parentCast.cast) {
          throw new Error('Could not find parent cast information');
        }

        let recipientAddress;

        // Check if parent cast was replying to an image AND bot's message indicates it was an image token
        if (parentCast.cast.parent_hash && 
            parentCast.cast.text.includes('dropped a banger image!')) {
          const grandparentCast = await neynar.lookupCastByHashOrWarpcastUrl({
            type: 'hash',
            identifier: parentCast.cast.parent_hash
          });

          // If parent was replying to an image, use grandparent's address
          recipientAddress = grandparentCast.cast.author.custody_address;
          console.log('Using image poster address:', recipientAddress);
        } else {
          // Otherwise use parent's address
          recipientAddress = parentCast.cast.author.custody_address;
          console.log('Using parent cast author address:', recipientAddress);
        }

        if (!recipientAddress) {
          throw new Error('Could not find valid recipient address');
        }

        // Create the UserRewardRecipient struct
        const recipientStruct = {
          recipient: recipientAddress,
          lpTokenId: positionId
        };

        console.log('Transferring ownership with struct:', recipientStruct);

        // Call replaceUserRewardRecipient
        const tx = await lpContract.replaceUserRewardRecipient(recipientStruct);
        console.log('Transaction sent:', tx.hash);

        // Wait for transaction to be mined
        const receipt = await tx.wait();
        console.log('Transaction confirmed:', receipt);

        return;
      } catch (error) {
        console.error('Error handling LP token transfer:', error);
        return;
      }
    }

    // If it's Clanker but without position ID/token, still return without responding
    if (fid.toString() === '874542') {
      console.log('Message from Clanker without token info - ignoring');
      return;
    }

    // Continue with normal bot behavior for all other cases
    console.log('Handling mention from non-Clanker FID:', fid);

    const isPfpRequest = castText.toLowerCase().includes('my pfp') || 
                        castText.toLowerCase().includes('my profile pic') ||
                        castText.toLowerCase().includes('my profile picture') ||
                        castText.toLowerCase().includes('my profile image') ||
                        castText.toLowerCase().includes('profile pic token') ||
                        castText.toLowerCase().includes('profile picture token') ||
                        castText.toLowerCase().includes('profile imagetoken') ||
                        castText.toLowerCase().includes('pfp token');
    
    // Add PFP check early in the function
    if (isPfpRequest) {
      const username = castData.author.username;
      const pfpKey = `${username}:pfp`;
      const existingPfp = await safeRedisGet(pfpKey);
      
      if (existingPfp) {
        console.log('User already has PFP token:', existingPfp);
        await createCastWithReply(replyToHash, "Only one pfp token per user fren, need to keep that rarity high.\n\nHit up my gloinked creator DiviFlyy if you need a fresh one!");
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
        try {
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
          
          // Try to generate token from PFP
          const imageData = {
            embeds: [{
              url: pfpUrl,
              metadata: {
                content_type: 'image/jpeg'
              }
            }]
          };
          
          const imageTokenDetails = await analyzeImage(imageData);
          if (!imageTokenDetails) {
            throw new Error('Failed to analyze profile picture');
          }
          
          tokenDetails = imageTokenDetails;
          message = `That is one glanked out pfp fren.\nHere's a token based on it:\n\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`;
          outputImage = pfpUrl;
          
        } catch (pfpError) {
          console.error('Error processing PFP request:', pfpError);
          await safeRedisDel(`${username}:pfp`);
          await createCastWithReply(replyToHash, "Sorry fren, I had trouble processing your profile picture! Make sure it's less than 5MB and try again.");
          return;
        }
      } else {
        await safeRedisDel(`${username}:pfp`);
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
          : castData.author.fid === fid
            ? `That is one glonkerized image fren.\nHere's a token based on it:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
            : `Woah @${castData.author.username} dropped a banger image!\nHere's a token based on it:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`;
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
        // Add new condition for referring to parent cast
        if (isReferringToParentCast(castText)) {
          console.log('User is referring to parent cast, analyzing only parent');
          analysis = await getRootCast(parentHash);
          if (!analysis) {
            console.log('Failed to get parent cast, falling back to user analysis');
            analysis = await analyzeCasts(targetFid);
          }
          tokenDetails = await generateTokenDetails(analysis, true);
        } else {
          // Existing logic
          analysis = await getRootCast(parentHash);
          if (!analysis) {
            analysis = await analyzeCasts(targetFid);
          }
          tokenDetails = await generateTokenDetails(analysis, false);
        }
      } else {
        analysis = await analyzeCasts(targetFid);
        tokenDetails = await generateTokenDetails(analysis, false);
      }
      
      const imageResult = await findRelevantImage(tokenDetails.name);
      outputImage = imageResult?.url || fallbackImages[Math.floor(Math.random() * fallbackImages.length)];
      
      // Modify message based on whether we're analyzing parent cast
      message = targetUsername
        ? `Ah, you want me to peep on other people's profiles?\nAlright fren, here's a token based on @${targetUsername}'s vibe:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
        : isReferringToParentCast(castText)
          ? `This cast is maximum gloinked fren.\nHere's a token based on it:\n\n@clanker create this token:\nName: ${tokenDetails.name}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
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

        const isAuthorized = await isAuthorizedCommenter(req.body.data);
        
        if (isAuthorized) {
          const authorFid = req.body.data.author.fid;
          const castHash = req.body.data.hash;
          const castText = req.body.data.text;
          const parentHash = req.body.data.parent_hash;
          const mentionedProfiles = req.body.data.mentioned_profiles;
          
          console.log('Processing authorized mention:', { authorFid, castHash, castText, parentHash });
          await handleMention(
            authorFid, 
            castHash, 
            castText, 
            parentHash, 
            mentionedProfiles,
            req.body.data
          ); 
        } else {
          console.log('Unauthorized interaction - ignoring');
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