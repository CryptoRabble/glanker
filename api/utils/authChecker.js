import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";
import { ethers } from 'ethers';
import { FACTORY_ABI } from './factoryabi.js';

const neynarConfig = new Configuration({
  apiKey: process.env.NEYNAR_API_KEY,
  baseOptions: {
    headers: {
      "x-neynar-experimental": true,
    },
  },
});
const neynar = new NeynarAPIClient(neynarConfig);

const FACTORY_ADDRESS = '0x503e881ace7b46f99168964aa7a484d87926bb17';
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);

export async function isAuthorizedCommenter(cast) {
  // Check if the cast author is the authorized FID
  if (cast.author.fid.toString() === '874542') {
    // First check the cast text
    const textUrlMatch = cast.text.match(/https:\/\/clanker\.world\/clanker\/(0x[a-fA-F0-9]{40})/);
    
    // Then check the embeds
    const embedUrlMatch = cast.embeds?.find(embed => 
      embed.url?.match(/https:\/\/clanker\.world\/clanker\/(0x[a-fA-F0-9]{40})/)
    );

    // Get the token address from either source
    const tokenAddress = textUrlMatch?.[1] || 
                        embedUrlMatch?.url.match(/https:\/\/clanker\.world\/clanker\/(0x[a-fA-F0-9]{40})/)?.[1];

    if (tokenAddress) {
      try {
        // Query the factory contract for deployment info
        const deploymentInfo = await factoryContract.deploymentInfoForToken(tokenAddress);
        console.log('Deployment info:', deploymentInfo);
        
        return {
          isAuthorized: true,
          positionId: deploymentInfo.positionId.toString(),
          tokenAddress: tokenAddress
        };
      } catch (error) {
        console.error('Error fetching deployment info:', error);
        return { isAuthorized: true }; // Still return authorized even if contract call fails
      }
    }
    return { isAuthorized: true };
  }

  // Check if the bot was directly mentioned
  if (cast.mentioned_profiles?.some(profile => 
    profile.fid.toString() === '885622'  // Bot's FID
  )) {
    return { isAuthorized: true };
  }

  // If this is a reply to another cast, check if it's replying to the bot's cast
  if (cast.parent_hash) {
    try {
      const parentCast = await neynar.lookupCastByHashOrWarpcastUrl({
        type: 'hash',
        identifier: cast.parent_hash
      });
      
      // If parent cast is from the bot and commenter is authorized FID
      if (parentCast.cast.author.fid.toString() === '885622' && 
          cast.author.fid.toString() === '874542') {
        return { isAuthorized: true };
      }
    } catch (error) {
      console.error('Error checking parent cast:', error);
      return { isAuthorized: false };
    }
  }

  return { isAuthorized: false };
}