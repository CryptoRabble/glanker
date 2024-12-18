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
  // Check if the cast author is Clanker
  if (cast.author.fid.toString() === '874542') {
    // Extract token address from URL in text or embeds
    const textUrlMatch = cast.text.match(/https:\/\/clanker\.world\/clanker\/(0x[a-fA-F0-9]{40})/);
    const embedUrlMatch = cast.embeds?.[0]?.url?.match(/https:\/\/clanker\.world\/clanker\/(0x[a-fA-F0-9]{40})/);
    
    const tokenAddress = textUrlMatch?.[1] || embedUrlMatch?.[1];

    if (tokenAddress) {
      return {
        isAuthorized: true,
        tokenAddress: tokenAddress
      };
    }
  }

  // Check if the bot was directly mentioned
  if (cast.mentioned_profiles?.some(profile => 
    profile.fid.toString() === '885622'  // Bot's FID
  )) {
    return { isAuthorized: true };
  }

  return { isAuthorized: false };
}