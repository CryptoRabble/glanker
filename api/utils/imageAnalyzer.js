// utils/imageAnalyzer.js
import { Anthropic } from '@anthropic-ai/sdk';
import axios from 'axios';

const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY
});

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

        // Get analysis from Claude
        const response = await anthropic.messages.create({
            model: "claude-3-sonnet-20240229",
            max_tokens: 1000,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: mediaType,
                            data: base64Image
                        }
                    },
                    {
                        type: "text",
                        text: `Generate a meme token name and ticker based on the uploaded image.
                        It should fit the image exactly. (E.g, if the image is of a word, the name should be that word, if there is a person or character with a unique feature, the name should be based on that feature, etc).
                        The name should not be a description though, (e.g, if the image is checkered pattern, the name should NOT be 'checkered'). create imaginitive names based on what the image looks like. 

                        Rules:
                        - Output only the name and ticker, each on a separate line. Nothing more.
                        - Do not use these words in any part of the output: Degen, crypto, obscure, vibe, vibecoin, coin, incoherent, coherent, quirky, blockchain, wild, blonde, anon, clanker, obscure, pot, base, mfer, mfers, stoner, weed, based, glonk, glonky, bot, simple, roast, dog, invest, buy, purchase, frames, quirky, meme, milo, memecoin, Doge, Pepe, scene, scenecoin, launguage, name, farther, higher, bleu, moxie, warpcast, farcaster.
                        - Use only the english alphabet
                        - Do not use the letters 'Q', 'X', and 'Z' too much
                        - Do not use any existing popular memecoin names in the output
                        - The name should be a real word
                        - The name can be 1 or 2 words
                        - The ticker should be the same as the name if the name is between 3-10 characters`
                    }
                ]
            }]
        });
        console.log('Claude image analysis response:', response);

        const lines = response.content[0].text.split('\n').filter(line => line.trim());
        if (lines.length < 2) {
            throw new Error('Invalid AI response format');
        }

        return {
            name: lines[0].trim(),
            ticker: lines[1].trim()
        };

    } catch (error) {
        console.error('Error analyzing image:', error);
        return null;
    }
}