import axios from 'axios';

async function searchImage(tokenName) {
  try {
    const giphyResponse = await axios.get(
      'https://api.giphy.com/v1/gifs/search',
      {
        params: {
          api_key: process.env.GIPHY_API_KEY,
          q: tokenName,
          limit: 3,
          rating: 'pg-13'
        }
      }
    );

    if (giphyResponse.data.data.length > 0) {
      const giphyResults = giphyResponse.data.data.filter(gif => {
        const width = parseInt(gif.images.original.width);
        const height = parseInt(gif.images.original.height);
        const aspectRatio = width / height;
        return width >= 100 &&    // Reduced from 200
               height >= 100 &&   // Reduced from 200
               aspectRatio <= 4 &&    // More lenient width ratio (was 3)
               aspectRatio >= 0.4;    // More lenient height ratio (was 0.67)
      });
      
      if (giphyResults.length > 0) {
        const randomIndex = Math.floor(Math.random() * giphyResults.length);
        const fullUrl = giphyResults[randomIndex].images.original.url;
        const pathSegments = fullUrl.split('/');
        const gifId = pathSegments[pathSegments.length - 2];
        const cleanUrl = `https://i.giphy.com/media/${gifId}/giphy.gif`;
        return { 
          success: true, 
          url: cleanUrl 
        };
      }
    }

    // Second Giphy attempt with first 4 letters
    const shortQuery = tokenName.slice(0, 4);
    const secondGiphyResponse = await axios.get(
      'https://api.giphy.com/v1/gifs/search',
      {
        params: {
          api_key: process.env.GIPHY_API_KEY,
          q: shortQuery,
          limit: 2,
          rating: 'pg-13'
        }
      }
    );

    if (secondGiphyResponse.data.data.length > 0) {
      const secondGiphyResults = secondGiphyResponse.data.data.filter(gif => {
        const width = parseInt(gif.images.original.width);
        const height = parseInt(gif.images.original.height);
        const aspectRatio = width / height;
        return width >= 100 &&
               height >= 100 &&
               aspectRatio <= 4 &&
               aspectRatio >= 0.4;
      });
      
      if (secondGiphyResults.length > 0) {
        const randomIndex = Math.floor(Math.random() * secondGiphyResults.length);
        const fullUrl = secondGiphyResults[randomIndex].images.original.url;
        const pathSegments = fullUrl.split('/');
        const gifId = pathSegments[pathSegments.length - 2];
        const cleanUrl = `https://i.giphy.com/media/${gifId}/giphy.gif`;
        return { 
          success: true, 
          url: cleanUrl 
        };
      }
    }
  } catch (giphyError) {
    console.error('Giphy API error:', giphyError);
  }

  // Fall back to Imgur if Giphy fails
  try {
    const imgurResponse = await axios.get(
      `https://api.imgur.com/3/gallery/search`,
      {
        headers: {
          'Authorization': `Client-ID ${process.env.IMGUR_CLIENT_ID}`
        },
        params: {
          q: tokenName,
          sort: 'top'
        }
      }
    );

    if (imgurResponse.data.data.length > 0) {
      const imgurResults = imgurResponse.data.data.filter(item => 
        !item.is_album && 
        item.width >= 200 && 
        item.height >= 200 &&
        !item.nsfw &&
        item.link
      );
      
      if (imgurResults.length > 0) {
        imgurResults.sort((a, b) => {
          const aScore = (a.score || 0) + (a.views || 0) / 1000;
          const bScore = (b.score || 0) + (b.views || 0) / 1000;
          return bScore - aScore;
        });

        const topResults = imgurResults.slice(0, 5);
        const randomIndex = Math.floor(Math.random() * topResults.length);
        return {
          success: true,
          url: topResults[randomIndex].link
        };
      }
    }
  } catch (imgurError) {
    console.error('Imgur API error:', imgurError);
  }
}

export async function findRelevantImage(tokenName) {
  return await searchImage(tokenName);
}