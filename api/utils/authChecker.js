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

const FACTORY_ADDRESS = '0x732560fa1d1A76350b1A500155BA978031B53833';
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const factoryContract = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);

export async function isAuthorizedCommenter(cast) {
  // Case 1: Check if the cast author is Clanker responding to glanker's prompt
  if (cast.author.fid.toString() === '874542' && cast.parent_author?.fid?.toString() === '885622') {
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

  // Case 2: Check if this is a new request explicitly mentioning glanker
  if (cast.mentioned_profiles?.some(profile => 
    profile.fid.toString() === '885622'  // Bot's FID
  )) {
    return { isAuthorized: true };
  }

  // Not authorized in all other cases
  return { isAuthorized: false };
}