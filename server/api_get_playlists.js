// api_get_playlists.js
// Fetches user playlists from Spotify server-side to avoid browser rate limits

exports.get_playlists = async (request, response) => {
    try {
        let access_token = request.query.token;
        if (!access_token) return response.status(400).json({ message: "Missing token" });

        let allPlaylists = [];
        let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
        let retries = 0;

        while (url && retries < 10) {
            let res = await fetch(url, { headers: { 'Authorization': `Bearer ${access_token}` } });
            
            if (res.status === 429) {
                let wait = parseInt(res.headers.get('retry-after') || '5');
                console.log(`Rate limited on playlists, waiting ${wait}s...`);
                await new Promise(r => setTimeout(r, wait * 1000));
                retries++;
                continue;
            }
            
            if (!res.ok) {
                let err = await res.text();
                console.log("Playlist fetch error:", res.status, err);
                return response.status(res.status).json({ message: err });
            }

            let data = await res.json();
            allPlaylists = [...allPlaylists, ...(data.items || [])];
            url = data.next;
            retries = 0; // reset retries on success
        }

        console.log("Fetched", allPlaylists.length, "playlists via backend");
        response.json({ playlists: allPlaylists });

    } catch (err) {
        console.log("ERROR fetching playlists:", err.message);
        response.status(500).json({ message: err.message });
    }
};
