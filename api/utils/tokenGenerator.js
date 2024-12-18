import { fetchQuery } from "@airstack/node";
import { anthropic } from '../webhook.js';  // Import anthropic from webhook.js

export async function analyzeCasts(fid) {
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

export async function generateTokenDetails(posts, isSingleCast = false) {
  const combinedContent = posts.map(p => p.text).join(' ');

  try {
    const promptContent = isSingleCast ? 
      `Generate a meme token name and ticker based specifically on this cast's content:
      "${combinedContent}"
      
      Create a token that directly references or plays off the specific content, theme, or message of this cast.
      It should be obvious that it relates to the cast, using a stand-out word(s) from the cast when possible.

      Rules: 
      - Output only the name and ticker, each on a separate line. Nothing more.
      - The name should cleverly reference the specific content or theme of the cast
      - Do not use these words in any part of the output: Degen, crypto, stand-out, obscure, obvious, incoherent, coherent, quirky, blockchain, wild, blonde, anon, clanker, obscure, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
      - The name should be a real word
      - The name can be 1 or 2 words
      - The ticker should be the same as the name
      - The name should not have 'token' or 'coin' in it
      - Use only the english alphabet
      - Do not use the letters 'Q', 'X', and 'Z' too much
      - Do not use any existing popular memecoin names in the output`
      :
      // Original prompt for analyzing multiple casts
      ` Generate a meme token name and ticker based on this user's posts. 
        You should take all posts into consideration and create an general idea for yourself on the personality of the person on which you base the token:
        User's posts: ${combinedContent}

        Please provide a token name and ticker. The name should roast the user slightly, and be fun, catchy, unique, and suitable for a meme token - come up with something completely fresh - the more obscure the better.

        Rules: 
        - Output only the name and ticker, each on a separate line. Nothing more.
        - Do not use these words in any part of the output: Degen, crypto, obscure, incoherent, obvious, coherent, quirky, blockchain, wild, blonde, anon, clanker, obscure, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
        - The name should be a real word
        - The name can be 1 or 2 words
        - The name should not have 'token' or 'coin' in it
        - The ticker should be the same as the name
        - Use only the english alphabet
        - Do not use the letters 'Q', 'X', and 'Z' too much
        - Do not use any existing popular memecoin names in the output`

    const message = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: promptContent
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