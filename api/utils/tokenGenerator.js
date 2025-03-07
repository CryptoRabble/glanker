import { anthropic } from '../webhook.js';  // Import anthropic from webhook.js

export async function analyzeCasts(fid) {
  console.log('Starting cast analysis for FID:', fid);
  if (!fid) {
    console.error('No FID provided to analyzeCasts');
    return [];
  }

  try {
    const url = `https://api.neynar.com/v2/farcaster/feed/user/casts?fid=${fid}&limit=15&include_replies=false`;
    console.log('Fetching casts from URL:', url);
    
    if (!process.env.NEYNAR_API_KEY) {
      console.error('NEYNAR_API_KEY not found in environment');
      return [];
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'api-key': process.env.NEYNAR_API_KEY // Note: changed from x-api-key to api-key
      }
    });

    console.log('Neynar API response status:', response.status);

    if (!response.ok) {
      console.error('Neynar API error:', response.status, await response.text());
      return [];
    }

    const data = await response.json();
    console.log('Retrieved raw data:', JSON.stringify(data).substring(0, 200) + '...');
    console.log('Retrieved casts count:', data.casts?.length || 0);
    
    if (!data.casts || !Array.isArray(data.casts)) {
      console.error('Invalid response format:', data);
      return [];
    }

    const processedCasts = data.casts.map(cast => ({
      text: cast.text,
      timestamp: new Date(cast.timestamp).getTime(),
      url: cast.parent_url || '',
      fid: cast.author.fid
    }));

    console.log('Processed casts:', processedCasts);
    return processedCasts;

  } catch (error) {
    console.error('Error analyzing casts:', error);
    console.error('Error stack:', error.stack);
    return [];
  }
}

export async function generateDescriptionDetails(posts, isSingleCast = false) {
  console.log('Starting generateDescriptionDetails with authorFid:', posts[0]?.fid);
  
  try {
    // Get the user's previous casts
    const userCasts = await analyzeCasts(posts[0]?.fid);
    console.log('Retrieved user casts:', userCasts);

    // Combine current posts with historical casts
    const allPosts = [...posts, ...userCasts];
    
    // Filter out bot's own posts
    const userPosts = allPosts.filter(p => p.username !== 'glanker');
    console.log('Filtered user posts:', userPosts);
    
    const combinedContent = userPosts.map(p => p.text).join(' ');
    console.log('Combined content:', combinedContent);

    if (isSingleCast) {
      return combinedContent;
    }

    // For multiple posts, keep existing behavior
    const promptContent = `Generate a description of this user based on their posts. 
      You should take all posts into consideration and create a description that directly plays off the personality of the user.
      User's posts: ${combinedContent}

      The description should roast the user slightly, and be fun, catchy, and unique - come up with something completely fresh - the more obscure the better.

      Rules: 
    - Output only the description. Nothing more.
    - Do not use these words in any part of the output: Degen, crypto, avatar, vibe, vibes, quirky, blockchain, wild, blonde, anon, clanker, obscure, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
    - Use only the english alphabet
    - Do not use any existing popular memecoin names in the output
    - The description should be 1-2 sentences`;

    const message = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: promptContent
      }]
    });

    return message.content[0].text.trim();
  } catch (error) {
    console.error('Description generation error:', error); 
    throw error;
  }
}

export async function generateSearchDetails(description, isSingleCast = false) {
  try {
    const promptContent = `
      Given this description of a person or situation:
    "${description}"
    
    Provide 2-3 funny, slightly roasting image search terms that match the tone and content of the description.
    Think of terms that playfully reference the person/situation - like what you'd search to find a reaction gif 
    that pokes fun at the described traits.
    
    Rules:
    - Terms must directly relate or reference the description's actual content
    - Put each term on its own line with a line break between terms
    - Output ONLY the search terms
    - Terms should be funny/memey but SFW
    - Do not use these words in any part of the output: Degen, avatar, vibe, vibes, crypto, stand-out, quirky, blockchain, wild, blonde, anon, clanker, obscure, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
    - Each term can be 1 or 2 words
    - Use only the english alphabet
    - Do not use the letters 'Q', 'X', and 'Z' too much
    - Do not use any existing popular memecoin names in the output`;

    const message = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: promptContent
      }]
    });

    const searchTerms = message.content[0].text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
   
    console.log('Generated search terms:', searchTerms);

    if (searchTerms.length === 0) {
      throw new Error('No search terms generated');
    }

    return {
      name: searchTerms.join(', '),
      ticker: ''
    };
  } catch (error) {
    console.error('Search terms generation error:', error); 
    throw error;
  }
}

export async function generateTokenDetails(description, isSingleCast = false) {
  try {
    // First, get the search terms from generateSearchDetails
    const searchTerms = await generateSearchDetails(description, isSingleCast);
    const searchTermsList = searchTerms.name.split(',').map(term => term.trim());

    const promptContent = `Given these potential terms:
    "${searchTermsList.join(', ')}"
    
    Select the most memeable term from the list above.
    Output only the chosen term on a single line, nothing more
    Output only the term, no other text or symbols`;

    const message = await anthropic.messages.create({
      model: "claude-3-sonnet-20240229",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: promptContent
      }]
    });

    const name = message.content[0].text.trim();
    let ticker;

    // Generate ticker based on the rules
    if (name.includes(' ')) {
      const [firstWord, secondWord] = name.split(' ');
      const combinedLength = firstWord.length + secondWord.length;
      
      if (combinedLength < 12) {
        // If combined words are less than 12 letters, combine them
        ticker = (firstWord + secondWord).toUpperCase();
      } else {
        // For longer combinations, use first 4 of first word + first 3 of second
        ticker = (firstWord.slice(0, 4) + secondWord.slice(0, 3)).toUpperCase();
      }
    } else if (name.length < 15) {
      // If one word less than 15 letters, use the whole word
      ticker = name.toUpperCase();
    } else {
      // If more than 15 letters, use first ten + last letter
      ticker = (name.slice(0, 10) + name.slice(-1)).toUpperCase();
    }

    return {
      name,
      ticker
    };
  } catch (error) {
    console.error('Token generation error:', error); 
    throw error;
  }
}

