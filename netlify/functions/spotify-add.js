// netlify/functions/spotify-add.js
// Uses Authorization Code + Client Secret flow — refresh tokens are permanent and don't rotate.
//
// Netlify env variables required:
//   SPOTIFY_CLIENT_ID      = 9e0f40d98e6c42c3b70887881e7eca74
//   SPOTIFY_CLIENT_SECRET  = 20219790db0448f781878fd724b97ed3
//   SPOTIFY_REFRESH_TOKEN  = (from get-token.html)

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const PLAYLIST_ID   = '3Njc1DbxO8o9PWXyfTuJW7';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function getFreshToken() {
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: REFRESH_TOKEN,
    }).toString(),
  });
  return res.json();
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.error('Missing env vars:', { CLIENT_ID: !!CLIENT_ID, CLIENT_SECRET: !!CLIENT_SECRET, REFRESH_TOKEN: !!REFRESH_TOKEN });
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured — check Netlify env variables' }) };
  }

  // GET — return access token for search
  if (event.httpMethod === 'GET') {
    const token = await getFreshToken();
    if (!token.access_token) {
      console.error('Token refresh failed:', token);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Token refresh failed', details: token }) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ access_token: token.access_token, expires_in: token.expires_in || 3600 }) };
  }

  // POST — add track to playlist
  if (event.httpMethod === 'POST') {
    let uri;
    try { ({ uri } = JSON.parse(event.body || '{}')); }
    catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

    if (!uri || !uri.startsWith('spotify:track:')) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid track URI' }) };
    }

    const token = await getFreshToken();
    if (!token.access_token) {
      console.error('Token refresh failed:', token);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Token refresh failed', details: token }) };
    }

    const addRes = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ uris: [uri] }),
    });

    if (addRes.ok) {
      console.log('Track added:', uri);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    const err = await addRes.json().catch(() => ({}));
    console.error('Add track failed:', addRes.status, err);
    return { statusCode: addRes.status, headers: CORS, body: JSON.stringify({ error: 'Spotify API error', details: err }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
