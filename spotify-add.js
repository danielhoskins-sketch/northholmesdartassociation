// netlify/functions/spotify-add.js
// GET  → returns a short-lived access token (for search)
// POST → adds a track to the playlist using the owner's refresh token
//
// Netlify env variables required:
//   SPOTIFY_CLIENT_ID      = 9e0f40d98e6c42c3b70887881e7eca74
//   SPOTIFY_REFRESH_TOKEN  = (captured from get-token.html)

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const PLAYLIST_ID   = '3Njc1DbxO8o9PWXyfTuJW7';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

async function getFreshToken() {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id:     CLIENT_ID,
    }),
  });
  return res.json();
}

exports.handler = async function(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (!CLIENT_ID || !REFRESH_TOKEN) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  // ── GET: return an access token for search ──────────────────────────────
  if (event.httpMethod === 'GET') {
    const tokenData = await getFreshToken();
    if (!tokenData.access_token) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Token refresh failed', details: tokenData }) };
    }
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ access_token: tokenData.access_token, expires_in: tokenData.expires_in }),
    };
  }

  // ── POST: add a track to the playlist ──────────────────────────────────
  if (event.httpMethod === 'POST') {
    let uri;
    try { ({ uri } = JSON.parse(event.body || '{}')); }
    catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request body' }) }; }

    if (!uri || !uri.startsWith('spotify:track:')) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid track URI' }) };
    }

    const tokenData = await getFreshToken();
    if (!tokenData.access_token) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Token refresh failed' }) };
    }

    const addRes = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${tokenData.access_token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ uris: [uri] }),
    });

    if (addRes.ok) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    const err = await addRes.json().catch(() => ({}));
    console.error('Spotify add failed:', addRes.status, err);
    return { statusCode: addRes.status, headers: CORS, body: JSON.stringify({ error: 'Spotify API error', details: err }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
