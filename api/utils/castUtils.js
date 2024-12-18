import { neynar } from '../webhook.js';  // Import neynar from webhook.js

export async function getRootCast(hash) {
  try {
    const response = await neynar.lookupCastByHashOrWarpcastUrl({
      type: 'hash',
      identifier: hash
    });
    
    return [{
      text: response.cast.text,
      castedAtTimestamp: response.cast.timestamp,
      url: '', 
      fid: response.cast.author.fid,
      username: response.cast.author.username
    }];
  } catch (error) {
    console.error('Error fetching root cast:', error);
    return null;
  }
}

export async function checkUserScore(fid) {
  try {
    const response = await neynar.fetchBulkUsers({ fids: fid.toString() });
    const userScore = response.users?.[0]?.experimental?.neynar_user_score || 0;
    
    console.log('User score for FID:', fid, 'Score:', userScore);
    return userScore >= 0.25;
  } catch (error) {
    console.error('Error checking user score:', error);
    return false;
  }
}

export function isReferringToParentCast(text) {
  const referenceTerms = [
    'this cast',
    'above cast',
    'parent cast',
    'previous cast',
    'that cast',
    'this post',
    'above post',
    'parent post',
    'previous post',
    'that post',
    'the post',
    'this cast',
    'his cast',
    'her cast',
    'their cast',
    'his post',
    'her post',
    'their post',
  ];
  return referenceTerms.some(term => text.toLowerCase().includes(term));
}