
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