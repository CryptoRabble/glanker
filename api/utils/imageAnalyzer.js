// utils/imageAnalyzer.js
import { Anthropic } from '@anthropic-ai/sdk';
import axios from 'axios';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

async function retryWithDelay(fn, retries = MAX_RETRIES, delay = RETRY_DELAY) {
    let lastError;
    
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            console.log(`Attempt ${i + 1} failed, retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

async function url_to_base64(imageUrl) {
    try {
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        
        const contentType = response.headers['content-type'];
        const base64Image = Buffer.from(response.data, 'binary').toString('base64');
        const mediaType = contentType || 'image/jpeg';
        
        return [base64Image, mediaType];
    } catch (error) {
        console.error('Error downloading image:', error);
        return [null, null];
    }
}

async function generateImageSearchTerms(description) {
    const result = await retryWithDelay(async () => {
        const promptContent = `
        Given this description of an image:
        "${description}"
        
        Provide 2-3 funny, slightly roasting search terms that would find a humorous image on Imgur.
        Think of terms that playfully tease what is in the image - like what you'd search to find a reaction gif 
        that pokes fun at the described traits.
        
        Rules:
        - Output ONLY the search terms
        - Put each term on its own line with a line break between terms
        - Terms should be funny/memey but SFW
        - Terms should directly relate to key elements in the image
        - Do not use these words: Degen, crypto, avatar, vibe, vibes, obscure, incoherent, obvious, coherent, quirky, blockchain, wild, blonde, anon, clanker, obscure, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe.
        - Each term can be 1 or 2 words
        - Use only the english alphabet`;

        const message = await anthropic.messages.create({
            model: "claude-3-sonnet-20240229",
            max_tokens: 100,
            messages: [{
                role: "user",
                content: promptContent
            }]
        });

        if (!message?.content?.[0]?.text) {
            throw new Error('Invalid response from Claude');
        }

        const terms = message.content[0].text
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
            
        if (terms.length === 0) {
            throw new Error('No valid search terms generated');
        }
        
        return terms;
    });

    return result;
}

async function generateImageTokenDetails(description, searchTerms) {
    const result = await retryWithDelay(async () => {
        // First select the most memeable term
        const promptContent = `Given these potential terms:
        "${searchTerms.join(', ')}"
        
        Select the most memeable term from the list above.
        Output only the chosen term on a single line.`;

        const message = await anthropic.messages.create({
            model: "claude-3-sonnet-20240229",
            max_tokens: 100,
            messages: [{
                role: "user",
                content: promptContent
            }]
        });

        if (!message?.content?.[0]?.text) {
            throw new Error('Invalid response from Claude');
        }

        const name = message.content[0].text.trim();
        if (!name) {
            throw new Error('Empty name generated');
        }

        // Generate ticker from the selected name
        let ticker;
        if (name.includes(' ')) {
            // If two words, handle based on first word length
            const [firstWord, secondWord] = name.split(' ');
            if (firstWord.length > 7) {
                // For long first words, combine first 4 letters of first word and first 3 of second
                ticker = (firstWord.slice(0, 4) + secondWord.slice(0, 3)).toUpperCase();
            } else {
                // Otherwise, use the first word as before
                ticker = firstWord.toUpperCase();
            }
        } else if (name.length < 7) {
            // If one word less than 7 letters, use the whole word
            ticker = name.toUpperCase();
        } else {
            // If more than 7 letters, use first six + last letter
            ticker = (name.slice(0, 6) + name.slice(-1)).toUpperCase();
        }

        return {
            name,
            ticker
        };
    });

    return result;
}

export async function analyzeImage(castData) {
    try {
        console.log('analyzeImage received:', castData);
        const imageEmbed = castData.embeds?.find(embed => 
            embed.metadata?.content_type?.startsWith('image/')
        );
        
        if (!imageEmbed) {
            console.log('No valid image embed found in analyzeImage');
            return null;
        }

        console.log('Processing image URL:', imageEmbed.url);
        
        // Convert image to base64
        const [base64Image, mediaType] = await url_to_base64(imageEmbed.url);
        if (!base64Image) {
            console.log('Failed to convert image to base64');
            return null;
        }
        console.log('Successfully converted image to base64');

        // Get initial description from Claude with retry
        const response = await retryWithDelay(async () => {
            const result = await anthropic.messages.create({
                model: "claude-3-sonnet-20240229",
                max_tokens: 1000,
                messages: [{
                    role: "user",
                    content: [
                        { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image }},
                        { type: "text", text: `Describe this image's most striking or humorous element in 1-2 sentences.
                            Focus on visual elements that could be used for a meme.
                            Be specific about what makes it funny or memorable.
                            
                            Rules:
                            - Output only the description
                            - Focus on visual elements
                            - Be specific and detailed
                            - Keep it light and humorous
                            - Use simple language` 
                        }
                    ]
                }]
            });

            // Validate response
            if (!result?.content?.[0]?.text) {
                throw new Error('Invalid response format from Claude');
            }

            return result;
        });

        const imageDescription = response.content[0].text.trim();
        console.log('Generated image description:', imageDescription);

        // Generate search terms from the description with retry
        const searchTerms = await retryWithDelay(async () => {
            const terms = await generateImageSearchTerms(imageDescription);
            if (!terms || terms.length === 0) {
                throw new Error('No valid search terms generated');
            }
            return terms;
        });

        // Generate final token details with retry
        const tokenDetails = await retryWithDelay(async () => {
            const details = await generateImageTokenDetails(imageDescription, searchTerms);
            if (!details?.name || !details?.ticker) {
                throw new Error('Invalid token details generated');
            }
            return details;
        });

        console.log('Generated token details:', tokenDetails);

        return {
            name: tokenDetails.name,
            ticker: tokenDetails.ticker,
            imageUrl: imageEmbed.url  // Return the original image URL
        };

    } catch (error) {
        console.error('Error analyzing image:', error);
        return null;
    }
}