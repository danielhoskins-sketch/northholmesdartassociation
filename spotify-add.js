// netlify/functions/spotify-add.js
// Authorization Code + Client Secret flow — stable non-rotating refresh tokens

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
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured' }) };
  }

  // GET — return access token for search
  if (event.httpMethod === 'GET') {
    const token = await getFreshToken();
    if (!token.access_token) {
      console.error('Token refresh failed:', JSON.stringify(token));
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Token refresh failed', details: token }) };
    }
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ access_token: token.access_token, expires_in: token.expires_in || 3600 }),
    };
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
      console.error('Token refresh failed:', JSON.stringify(token));
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Token refresh failed', details: token }) };
    }

    const authHeader = { 'Authorization': `Bearer ${token.access_token}`, 'Content-Type': 'application/json' };

    // Ensure playlist is collaborative so anyone can add
    const colabRes = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}`, {
      method:  'PUT',
      headers: authHeader,
      body:    JSON.stringify({ collaborative: true, public: false }),
    });
    if (!colabRes.ok) {
      const colabErr = await colabRes.json().catch(() => ({}));
      console.error('Set collaborative failed:', colabRes.status, JSON.stringify(colabErr));
      // Don't block — still attempt the add
    }

    // Add the track
    const addRes = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks`, {
      method:  'POST',
      headers: authHeader,
      body:    JSON.stringify({ uris: [uri] }),
    });

    if (addRes.ok) {
      console.log('Track added successfully:', uri);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ success: true }) };
    }

    const err = await addRes.json().catch(() => ({}));
    console.error('Add track failed:', addRes.status, JSON.stringify(err));
    return {
      statusCode: addRes.status, headers: CORS,
      body: JSON.stringify({
        error:   err.error?.message || 'Spotify API error',
        status:  addRes.status,
        details: err,
      }),
    };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
