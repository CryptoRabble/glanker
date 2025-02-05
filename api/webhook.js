import { init } from "@airstack/node";
import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import { Anthropic } from '@anthropic-ai/sdk';
import crypto from 'crypto';
import { safeRedisGet, safeRedisSet, safeRedisDel } from './utils/redis.js';
import { getRootCast, checkUserScore, isReferringToParentCast } from './utils/castUtils.js';
import { analyzeImage } from './utils/imageAnalyzer.js';
import { isAuthorizedCommenter } from './utils/authChecker.js';
import { findRelevantImage } from './utils/imageSearch.js';
import { analyzeCasts, generateTokenDetails, generateDescriptionDetails } from './utils/tokenGenerator.js';
import { ethers } from 'ethers'
import { LP_ABI } from './utils/lpabi.js';
import { FACTORY_ABI } from './utils/factoryabi.js';
const LP_CONTRACT_ADDRESS = '0x5eC4f99F342038c67a312a166Ff56e6D70383D86'
const FACTORY_ADDRESS = '0x375C15db32D28cEcdcAB5C03Ab889bf15cbD2c5E'


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

async function handleMention(fid, replyToHash, castText, parentHash, mentionedProfiles, castData, tokenAddress) {
  let message;
  let outputImage;
  let tokenDetails = null;

  try {
    console.log('Handling mention from FID:', fid);
    
    // Handle Clanker responses first
    if (fid.toString() === '874542' && tokenAddress) {
      try {
        const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const lpContract = new ethers.Contract(LP_CONTRACT_ADDRESS, LP_ABI, signer);
        const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
        
        // Get parent cast (glanker's response)
        console.log('Parent cast hash:', parentHash);

        const parentCast = await neynar.lookupCastByHashOrWarpcastUrl({
          type: 'hash',
          identifier: parentHash
        });

        // Get deployment info from factory contract
        const deploymentInfo = await factoryContract.deploymentInfoForToken(tokenAddress);
        console.log('Deployment info:', deploymentInfo);
        
        // Correctly access the positionId from the struct
        // deploymentInfo returns { token, positionId, locker }
        const positionId = deploymentInfo[1]; // or deploymentInfo.positionId if using named properties
        console.log('Position ID from factory:', positionId);

        // Verify the deployment info
        if (deploymentInfo[0] !== tokenAddress) {
          console.error('Token address mismatch:', {
            expected: tokenAddress,
            received: deploymentInfo[0]
          });
          throw new Error('Token address mismatch');
        }

        // Verify the locker address matches
        if (deploymentInfo[2].toLowerCase() !== LP_CONTRACT_ADDRESS.toLowerCase()) {
          console.error('Locker address mismatch:', {
            expected: LP_CONTRACT_ADDRESS,
            received: deploymentInfo[2]
          });
          throw new Error('Locker address mismatch');
        }

        // Add validation check for position ID
        if (!positionId || positionId.toString() === '0') {
          throw new Error('Invalid position ID returned from factory');
        }

        // Get grandparent cast (DiviFlyy's request)
        const grandparentCast = await neynar.lookupCastByHashOrWarpcastUrl({
          type: 'hash',
          identifier: parentCast.cast.parent_hash
        });

        let recipientAddress;

        // Check if glanker's message indicates it was an image token
        if (parentCast.cast.text.includes('dropped a banger image!')) {
          // Get great-grandparent cast (original image post)
          const greatGrandparentCast = await neynar.lookupCastByHashOrWarpcastUrl({
            type: 'hash',
            identifier: grandparentCast.cast.parent_hash
          });
          
          // Use the image poster's verified address
          recipientAddress = greatGrandparentCast.cast.author.verifications?.[0];
          
          if (!recipientAddress) {
            console.log('No verified address found for image poster:', greatGrandparentCast.cast.author.username);
            throw new Error('Image poster has no verified address');
          }
          
          console.log('Using image poster address:', {
            username: greatGrandparentCast.cast.author.username,
            verified_address: recipientAddress
          });
        } else {
          // Default case: use DiviFlyy's verified address
          recipientAddress = grandparentCast.cast.author.verifications?.[0];
          
          if (!recipientAddress) {
            console.log('No verified address found for requester:', grandparentCast.cast.author.username);
            throw new Error('Requester has no verified address');
          }

          console.log('Using requester address:', {
            username: grandparentCast.cast.author.username,
            verified_address: recipientAddress
          });
        }

        if (!recipientAddress) {
          throw new Error('Could not find valid verified address for recipient');
        }

        // Create the UserRewardRecipient struct
        const recipientStruct = {
          recipient: recipientAddress,
          lpTokenId: positionId
        };

        console.log('Transferring ownership with struct:', recipientStruct);

        // First check if we can estimate the gas (this will catch most errors)
        try {
          const gasEstimate = await lpContract.replaceUserRewardRecipient.estimateGas(recipientStruct);
          console.log('Gas estimate:', gasEstimate.toString());
          
          // If gas estimation succeeds, send the transaction with a higher gas limit
          const tx = await lpContract.replaceUserRewardRecipient(recipientStruct, {
            gasLimit: Math.floor(gasEstimate * 1.2) // Add 20% buffer
          });
          
          console.log('Transaction sent:', tx.hash);
          const receipt = await tx.wait();
          console.log('Transaction confirmed:', receipt);
        } catch (error) {
          // Parse the error to provide more specific feedback
          if (error.data?.includes('0x815e1d64')) { // InvalidTokenId error signature
            console.error('Invalid token ID error:', positionId);
            throw new Error(`Invalid token ID: ${positionId}`);
          } else if (error.data?.includes('0x4ca88867')) { // NotAllowed error signature
            console.error('Not allowed error for address:', signerAddress);
            throw new Error(`Address ${signerAddress} not allowed to transfer token`);
          } else {
            console.error('Transaction error:', error);
            throw error;
          }
        }

        return;
      } catch (error) {
        console.error('Error handling LP token transfer:', error);
        throw error;
      }
    }

    // If it's Clanker, don't process further
    if (fid.toString() === '874542') {
      console.log('Message from Clanker - ignoring');
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
      console.log('Processing profile picture request');
      const pfpUrl = castData.author.pfp_url;
      const username = castData.author.username;
      console.log('Found profile picture:', pfpUrl);
      
      // Check if this PFP request was already processed
      const pfpData = await safeRedisGet(`${username}:pfp`);
      if (pfpData) {
        console.log('PFP request already processed:', pfpData);
        await createCastWithReply(replyToHash, "Only one pfp token per user fren, need to keep that rarity high.\n\nHit up my gloinked creator DiviFlyy if you need a fresh one!");
        return;
      }
      
      if (pfpUrl) {
        try {
          const imageData = {
            embeds: [{
              url: pfpUrl,
              metadata: {
                content_type: 'image/jpeg'
              }
            }]
          };

          // Store PFP request in Redis
          const castUrl = `https://warpcast.com/${username}/${replyToHash}`;
          await safeRedisSet(`${username}:pfp`, JSON.stringify({
            castUrl: castUrl,
            hash: replyToHash,
            timestamp: Date.now()
          }));
          
          // Generate token from PFP
          const pfpTokenDetails = await analyzeImage(imageData);
          
          if (!pfpTokenDetails) {
            throw new Error('Failed to analyze profile picture');
          }

          // Capitalize each word in the name
          const capitalizedName = pfpTokenDetails.name
            .toLowerCase()
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
          
          const pfpMessage = `Woah fren, that's one glankster pfp!\nI'll immortalize it as a token:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${pfpTokenDetails.ticker.toUpperCase()}`;
          
          await createCastWithReply(replyToHash, pfpMessage, pfpUrl);
          return;
          
        } catch (pfpError) {
          console.error('Error processing PFP request:', pfpError);
          await safeRedisDel(`${username}:pfp`);
          await createCastWithReply(replyToHash, "Sorry fren, I had trouble processing your profile picture! Make sure it's less than 5MB and try again.");
          return;
        }
      } else {
        await createCastWithReply(replyToHash, "Sorry fren, I couldn't find your profile picture!");
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
        const today = new Date().setHours(0, 0, 0, 0);
        
        // Initialize or update tokens generated today
        if (!parsedData.lastDate || parsedData.lastDate < today) {
          // Reset counter for new day
          parsedData.tokensToday = 1;
          parsedData.lastDate = today;
        } else if (parsedData.tokensToday >= 3) {
          console.log('Daily limit reached, sending cooldown message');
          await createCastWithReply(replyToHash, `${userResponse}I can only glank out 3 fresh bangers for you per day. Radiate some new casts and try again tomorrow!`);
          return;
        } else {
          // Increment counter for today
          parsedData.tokensToday++;
        }
        
        parsedData.lastGenerated = now;
        await safeRedisSet(redisKey, JSON.stringify(parsedData));
      } else {
        // First token of the day
        await safeRedisSet(redisKey, JSON.stringify({
          lastGenerated: now,
          lastDate: new Date().setHours(0, 0, 0, 0),
          tokensToday: 1
        }));
      }

      console.log('Proceeding with token generation');
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
      
      const imageData = {
        embeds: [{
          url: outputImage,
          metadata: {
            content_type: 'image/jpeg'
          }
        }]
      };
      console.log('Sending to analyzeImage:', imageData);
      
      tokenDetails = await analyzeImage(imageData);
      console.log('Image analysis result:', tokenDetails);
      
      if (tokenDetails) {
        const capitalizedName = tokenDetails.name
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
        tokenDetails.name = capitalizedName;

        message = isPfpRequest 
          ? `Woah fren, that's one glankster pfp!\nI'll immortalize it as a token:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
          : castData.author.fid === fid
            ? `That is one glonkerized image fren.\nHere's a token based on it:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
            : `Woah @${castData.author.username} dropped a banger image!\nHere's a token based on it:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${tokenDetails.ticker.toUpperCase()}`;
      } else {
        // Fallback to text-based generation if image analysis fails
        let analysis;
        if (parentHash) {
          if (isReferringToParentCast(castText)) {
            console.log('User is referring to parent cast, analyzing only parent');
            analysis = await getRootCast(parentHash);
            if (!analysis) {
              console.log('Failed to get parent cast, falling back to user analysis');
              analysis = await analyzeCasts(targetFid);
            }
          } else {
            analysis = await getRootCast(parentHash);
            if (!analysis) {
              analysis = await analyzeCasts(targetFid);
            }
          }
        } else {
          analysis = await analyzeCasts(targetFid);
        }

        // Generate description first
        const description = await generateDescriptionDetails(analysis, isReferringToParentCast(castText));
        console.log('Generated description:', description);

        // Use description to generate token details
        tokenDetails = await generateTokenDetails(description);
        console.log('Generated token details:', tokenDetails);

        // Capitalize the name before using it
        const capitalizedName = tokenDetails.name
          .split(' ')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
        tokenDetails.name = capitalizedName;

        const imageResult = await findRelevantImage(tokenDetails.name, description);
        outputImage = imageResult?.url || fallbackImages[Math.floor(Math.random() * fallbackImages.length)];

        // Keep original message format
        message = targetUsername
          ? `Ah, you want me to peep on other people's profiles?\nAlright fren, here's a token based on @${targetUsername}'s vibe:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
          : isReferringToParentCast(castText)
            ? `This cast is maximum gloinked fren.\nHere's a token based on it:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
            : mentionText 
              ? `${userResponse}I scrolled through your casts... they're pretty glonky.\nHere's a token based on your vibe:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
              : `Here's a token based on your vibe:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${tokenDetails.ticker.toUpperCase()}`;
      }
    } else {
      // No image, use text-based generation
      let analysis;
      if (parentHash) {
        if (isReferringToParentCast(castText)) {
          console.log('User is referring to parent cast, analyzing only parent');
          analysis = await getRootCast(parentHash);
          if (!analysis) {
            console.log('Failed to get parent cast, falling back to user analysis');
            analysis = await analyzeCasts(targetFid);
          }
        } else {
          analysis = await getRootCast(parentHash);
          if (!analysis) {
            analysis = await analyzeCasts(targetFid);
          }
        }
      } else {
        analysis = await analyzeCasts(targetFid);
      }
      
      // Generate description first
      const description = await generateDescriptionDetails(analysis, isReferringToParentCast(castText));
      console.log('Generated description:', description);

      // Use description to generate token details
      tokenDetails = await generateTokenDetails(description);
      console.log('Generated token details:', tokenDetails);

      // Capitalize the name before using it
      const capitalizedName = tokenDetails.name
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      tokenDetails.name = capitalizedName;

      const imageResult = await findRelevantImage(tokenDetails.name, description);
      outputImage = imageResult?.url || fallbackImages[Math.floor(Math.random() * fallbackImages.length)];
      
      // Modify message to include the description
      message = targetUsername
        ? `Ah, you want me to peep on other people's profiles?\nAlright fren, here's a token based on @${targetUsername}'s vibe:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
        : isReferringToParentCast(castText)
          ? `This cast is maximum gloinked fren.\nHere's a token based on it:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${tokenDetails.ticker.toUpperCase()}`
          : `${userResponse}I scrolled through your casts... they're pretty glonky.\nHere's a token based on your vibe:\n\n@clanker create this token:\nName: ${capitalizedName}\nTicker: ${tokenDetails.ticker.toUpperCase()}`;
    }

    return await createCastWithReply(replyToHash, message, outputImage);
  } catch (error) {
    console.error('Error in handleMention:', error);
    await createCastWithReply(replyToHash, "Sorry fren, something went wrong while processing your request!");
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
  console.log('Mentioned profiles:', req.body.data?.mentioned_profiles);
  console.log('Cast text:', req.body.data?.text);

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

    // Move idempotency check here, after signature verification
    const castHash = req.body.data?.hash;
    if (castHash) {
      const castKey = `processed_cast:${castHash}`;
      const isProcessed = await safeRedisGet(castKey);
      
      if (isProcessed) {
        console.log('Cast already processed:', castHash);
        return res.status(200).json({ status: 'Already processed' });
      }

      // Set processed flag immediately after verifying it's not processed
      await safeRedisSet(castKey, '1', 3600); // Keep for 1 hour
    }

    try {
      if (req.body.type === 'cast.created') {
        console.log('Cast created event received');
        console.log('Mentioned profiles:', req.body.data.mentioned_profiles);
        console.log('Author FID:', req.body.data.author.fid);

        const isAuthorized = await isAuthorizedCommenter(req.body.data);
        console.log('Authorization result:', isAuthorized);
        
        if (isAuthorized.isAuthorized) {
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
            req.body.data,
            isAuthorized.tokenAddress
          ); 
        } else {
          console.log('Unauthorized interaction - ignoring. Reason:', isAuthorized);
          return res.status(200).json({ status: 'Unauthorized interaction ignored' });
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