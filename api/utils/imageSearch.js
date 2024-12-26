import axios from 'axios';
import { anthropic } from '../webhook.js';
import { safeRedisGet2, safeRedisSet2 } from './redis2.js';

async function url_to_base64(imageUrl) {
    try {
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'arraybuffer',
            timeout: 5000, // 5 second timeout
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

async function checkImageForText(imageUrl) {
    try {
        // Add 5 second timeout for individual image checks
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Image check timeout')), 5000)
        );

        const checkPromise = (async () => {
            const [base64Image, mediaType] = await url_to_base64(imageUrl);
            if (!base64Image) return false;

            const textCheckResponse = await anthropic.messages.create({
                model: "claude-3-sonnet-20240229",
                max_tokens: 50,
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
                            text: `Does this image contain any text or words? Answer with only "yes" or "no".`
                        }
                    ]
                }]
            });

            const hasText = textCheckResponse.content[0].text.trim().toLowerCase() === 'yes';
            if (hasText) {
                await safeRedisSet2(`banned_image:${imageUrl}`, '1');
                console.log('Added image with text to banned list:', imageUrl);
            }
            return hasText;
        })();

        return await Promise.race([checkPromise, timeoutPromise]);
    } catch (error) {
        console.error('Error checking for text:', error);
        return false;
    }
}

async function isImageBanned(imageUrl) {
    try {
        const banned = await safeRedisGet2(`banned_image:${imageUrl}`);
        return !!banned;
    } catch (error) {
        console.error('Error checking banned image:', error);
        return false;
    }
}

async function getImgurResults(searchTerm, limit = 4) {
    console.log(`Fetching Imgur results for: ${searchTerm}`);
    
    const response = await axios.get(
        `https://api.imgur.com/3/gallery/search`,
        {
            headers: {
                'Authorization': `Client-ID ${process.env.IMGUR_CLIENT_ID}`
            },
            params: {
                q: searchTerm,
                sort: 'viral'
            }
        }
    );

    // Filter valid images first
    const validImages = response.data.data
        .filter(item => {
            if (item.is_album && (!item.images || !item.images[0])) return false;
            
            const image = item.is_album ? item.images[0] : item;
            const isValid = (
                image.width >= 200 &&
                image.height >= 200 &&
                !image.nsfw &&
                image.link &&
                /\.(jpg|jpeg|png|gif)$/i.test(image.link)
            );
            
            if (!isValid) {
                console.log(`Filtered out invalid image: ${image.link}`);
            }
            return isValid;
        })
        .map(item => {
            if (item.is_album && item.images && item.images[0]) {
                return {
                    ...item.images[0],
                    score: item.score || 0,
                    views: item.views || 0,
                    link: item.images[0].link
                };
            }
            return item;
        })
        .sort((a, b) => {
            const aScore = (a.score || 0) + (a.views || 0) / 1000;
            const bScore = (b.score || 0) + (b.views || 0) / 1000;
            return bScore - aScore;
        });

    // Take top 10 and shuffle them
    const top10 = validImages.slice(0, 10);
    console.log(`Found ${top10.length} top images, shuffling...`);
    
    const shuffled = top10
        .map(value => ({ value, sort: Math.random() }))
        .sort((a, b) => a.sort - b.sort)
        .map(({ value }) => value);

    const selected = shuffled.slice(0, limit);
    console.log('Selected images for processing:', selected.map(img => img.link));
    
    return selected;
}

async function giphyFallback(query) {
    try {
        const response = await axios.get(
            'https://api.giphy.com/v1/gifs/search',
            {
                params: {
                    api_key: process.env.GIPHY_API_KEY,
                    q: query,
                    limit: 1,
                    rating: 'pg-13'
                }
            }
        );

        if (response.data.data.length > 0) {
            const gif = response.data.data[0];
            const fullUrl = gif.images.original.url;
            const pathSegments = fullUrl.split('/');
            const gifId = pathSegments[pathSegments.length - 2];
            const cleanUrl = `https://i.giphy.com/media/${gifId}/giphy.gif`;
            
            await safeRedisSet2(`banned_image:${cleanUrl}`, '1');
            console.log('Added Giphy fallback image to banned list:', cleanUrl);
            return { success: true, url: cleanUrl };
        }
    } catch (error) {
        console.error('Giphy fallback error:', error);
    }
    return { success: false };
}

async function getFallbackSearchTerm(tokenName) {
    try {
        const promptContent = `Given this token name:
Token: "${tokenName}"

Choose ONE word that would make a good reaction image or meme search term.
Look at the token name first, and if it's too complex or abstract, pick a simpler emotional reaction that matches its vibe.

Rules:
- Output a single word only
- If the token name is abstract/complex, translate it to a basic emotion/reaction
- Keep it SFW and non-offensive

Output only the word, nothing else.`;

        const message = await anthropic.messages.create({
            model: "claude-3-sonnet-20240229",
            max_tokens: 20,
            messages: [{
                role: "user",
                content: promptContent
            }]
        });

        return message.content[0].text.trim();
    } catch (error) {
        console.error('Error getting fallback term:', error);
        return tokenName.split(' ')[0];
    }
}

async function searchImage(tokenName, description) {
    try {
        // 8 second timeout for error handling
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Search timeout')), 8000)
        );

        const searchPromise = (async () => {
            // Take first word and first fallback term immediately to reduce processing time
            const initialSearchTerm = tokenName.toLowerCase().split(' ')[0];
            const fallbackTerm = await getFallbackSearchTerm(tokenName);
            
            // Process both search terms in parallel
            const [initialResults, fallbackResults] = await Promise.all([
                getImgurResults(initialSearchTerm, 4),  // Keep 4 images
                getImgurResults(fallbackTerm, 4)        // Keep 4 images
            ]);
            
            // Process initial results
            if (initialResults.length > 0) {
                const validResult = await findFirstValidImage(initialResults);
                if (validResult) {
                    await safeRedisSet2(`banned_image:${validResult.link}`, '1');
                    return { success: true, url: validResult.link };
                }
            }
            
            // Process fallback results
            if (fallbackResults.length > 0) {
                const validResult = await findFirstValidImage(fallbackResults);
                if (validResult) {
                    await safeRedisSet2(`banned_image:${validResult.link}`, '1');
                    return { success: true, url: validResult.link };
                }
            }

            // Final Giphy fallback
            return await giphyFallback(tokenName);
        })();

        return await Promise.race([searchPromise, timeoutPromise]);

    } catch (error) {
        console.error('Search error:', error);
        return await giphyFallback(tokenName);
    }
}

// Update findFirstValidImage to check images in parallel
async function findFirstValidImage(images) {
    try {
        // Check all images in parallel
        const checks = images.map(async (item) => {
            if (await isImageBanned(item.link)) {
                console.log('Filtered out - banned image:', item.link);
                return null;
            }
            
            const hasText = await checkImageForText(item.link);
            if (hasText) {
                console.log('Filtered out - contains text:', item.link);
                return null;
            }
            
            return item;
        });

        // Wait for all checks to complete with a timeout
        const results = await Promise.all(checks);
        
        // Return first valid image
        return results.find(result => result !== null) || null;
    } catch (error) {
        console.error('Error in findFirstValidImage:', error);
        return null;
    }
}

export async function findRelevantImage(tokenName, description) {
    return await searchImage(tokenName, description);
}