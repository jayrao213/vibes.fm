//
// API function: post /playlist
//
// Fetches the songs from a Spotify playlist and inserts them into the database.
//
// Author:
//   Jay Rao
//   Northwestern University
//

const mysql2 = require('mysql2/promise');
const { get_dbConn, get_spotify } = require('./helper.js');
//
// p_retry requires the use of a dynamic import:
// const pRetry = require('p-retry');
//
const pRetry = (...args) => import('p-retry').then(({default: pRetry}) => pRetry(...args));


/**
* post_playlist:
*
* @description uploads all the songs (id, name, artsist, album) from the Spotify playlist 
 (given with its playlist_id by the user) into the database and upon success a JSON
* object of the form {message: ..., playlist_id: ...} is sent where message is
* "success" and playlist_id is the playlist's original id.
* If an error occurs, a status code of 500 or the given status code by Spotify
* is sent where the JSON object's message is the error message and assetid is -1. 
*
* @param request body {playlist_id: string}
* @returns JSON {message: string, playlist_id: string}
*/

exports.post_playlist = async (request, response) => {

    async function try_post_playlist() {
        let dbConn;
        try {
        // Support for dynamic Frontend Users
        let access_token = request.body.access_token;

        if (!access_token) {
            // Fallback for Python local testing
            const spotify = get_spotify();
            const client_id = spotify.client_id;
            const client_secret = spotify.client_secret;
            const refresh_token = spotify.refresh_token;

            let auth_url = "https://accounts.spotify.com/api/token";

            let auth_options = {
                method: "POST",
                headers: {
                    "Authorization": "Basic " + (Buffer.from(client_id + ':' + client_secret).toString('base64')),
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refresh_token,
                    client_id: client_id
                })
            }

            let auth_response = await fetch(auth_url, auth_options);

            if (auth_response.status == 200) {
                let auth_data = await auth_response.json();
                access_token = auth_data.access_token;
            } else {
                const error = new Error("Spotify Auth API error");
                error.status_code = auth_response.status;
                throw error;
            }
        }
        
        //
        // open connection to database:
        //
        dbConn = await get_dbConn();

        await dbConn.beginTransaction();

        let playlist_id = request.body.playlist_id;

        let base_url = "https://api.spotify.com/v1/playlists/" + playlist_id + "/items?limit=50&";
        let offset = 0;
        let playlist_url = base_url + "offset=" + offset;

        let playlist_options = {
            method: "GET",
            headers: { "Authorization": "Bearer " + access_token }
        };

        // Ensure playlist exists in `playlists` tracking table
        let playlist_sql = `INSERT IGNORE INTO playlists (playlist_id) VALUES (?);`;       
        await dbConn.execute(playlist_sql, [playlist_id]);

        // Get currently mapped songs for this playlist to compute diffs
        let existing_song_ids = new Set();
        try {
            let [existing_mapped_rows, _] = await dbConn.execute(`SELECT song_id FROM playlist_songs WHERE playlist_id = ?`, [playlist_id]);
            existing_song_ids = new Set(existing_mapped_rows.map(r => r.song_id));
        } catch (e) {
            // In case table doesn't exist or is empty
            console.log("No existing mappings found or error:", e.message);
        }

        let spotify_tracks = [];
        let spotify_track_ids = new Set();

        while (playlist_url != null) {
            let playlist_response = await fetch(playlist_url, playlist_options);
            if (playlist_response.status == 200) {
                let playlist_data = await playlist_response.json();
                let items = playlist_data.items;
                if (items.length == 0) break;
                
                offset += items.length;
                for (let item of items) {
                    let track = item.item;
                    if (track && track.id) {
                        spotify_tracks.push(track);
                        spotify_track_ids.add(track.id);
                    }
                }
                playlist_url = base_url + "offset=" + offset;
            } else {
                const error = new Error("Spotify Playlist API Error");
                error.status_code = playlist_response.status;
                throw error;   
            }
        }

        // 1. Process Removals: Songs currently in playlist_songs but gone from Spotify
        let songs_to_remove = [];
        for (let id of existing_song_ids) {
            if (!spotify_track_ids.has(id)) {
                songs_to_remove.push(id);
            }
        }
        if (songs_to_remove.length > 0) {
            for (let id of songs_to_remove) {
                await dbConn.execute('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?', [playlist_id, id]);
            }
        }

        // 2. Process Additions
        let new_tracks = spotify_tracks.filter(t => !existing_song_ids.has(t.id));

        // Find which new tracks already exist globally in `songs` table
        let global_existing_ids = new Set();
        if (new_tracks.length > 0) {
            let all_new_track_ids = new_tracks.map(t => t.id);
            // Check in chunks of 100 to avoid long IN clauses
            for (let i = 0; i < all_new_track_ids.length; i += 100) {
                let chunk = all_new_track_ids.slice(i, i + 100);
                let placeholders = chunk.map(() => '?').join(',');
                let [rows, _] = await dbConn.execute(`SELECT song_id FROM songs WHERE song_id IN (${placeholders})`, chunk);
                for (let row of rows) global_existing_ids.add(row.song_id);
            }
        }

        // Add mappings for the ones that already exist globally
        for (let track of new_tracks) {
            if (global_existing_ids.has(track.id)) {
                await dbConn.execute('INSERT IGNORE INTO playlist_songs (playlist_id, song_id) VALUES (?, ?)', [playlist_id, track.id]);
            }
        }

        // 3. Process Completely New Songs (Need enriching)
        let songs_to_fetch = new_tracks.filter(t => !global_existing_ids.has(t.id));
        let song_sql = `INSERT IGNORE INTO songs (song_id, name, artist, album, genres, audio_features, lyrics, popularity, explicit, release_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`;

        // Process in batches of 50 for API limits
        for (let i = 0; i < songs_to_fetch.length; i += 50) {
            let chunk = songs_to_fetch.slice(i, i + 50);
            
            // Fetch Audio Features
            let chunk_ids = chunk.map(t => t.id).join(',');
            let audio_features_map = {};
            try {
                let af_resp = await fetch(`https://api.spotify.com/v1/audio-features?ids=${chunk_ids}`, playlist_options);
                if (af_resp.status == 200) {
                    let af_data = await af_resp.json();
                    if (af_data.audio_features) {
                        for (let af of af_data.audio_features) { if (af) audio_features_map[af.id] = af; }
                    }
                }
            } catch (e) { console.log("Failed audio features fetch:", e); }

            // Fetch Artist Genres
            let artist_ids = chunk.map(t => t.artists[0]?.id).filter(id => id).join(',');
            let artist_genres_map = {};
            try {
                let ar_resp = await fetch(`https://api.spotify.com/v1/artists?ids=${artist_ids}`, playlist_options);
                if (ar_resp.status == 200) {
                    let ar_data = await ar_resp.json();
                    if (ar_data.artists) {
                        for (let ar of ar_data.artists) { if (ar) artist_genres_map[ar.id] = ar.genres; }
                    }
                }
            } catch (e) { console.log("Failed artsits fetch:", e); }

            // Insert each song
            for (let track of chunk) {
                let song_id = track.id;
                let name = track.name;
                let artist_obj = track.artists ? track.artists[0] : null;
                let artist = artist_obj ? artist_obj.name : "Unknown";
                let artist_id = artist_obj ? artist_obj.id : null;
                let album = track.album?.name || "Unknown";
                let popularity = track.popularity || 0;
                let explicit = track.explicit ? 1 : 0;
                let release_date = track.album?.release_date || "Unknown";
                
                let af = audio_features_map[song_id] || null;
                let genres = artist_id ? (artist_genres_map[artist_id] || []) : [];
                
                // Fetch Lyrics safely with timeout
                let lyrics = "";
                try {
                    let lyrics_resp = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(2000) });
                    if (lyrics_resp.status == 200) {
                        let lyrics_data = await lyrics_resp.json();
                        lyrics = lyrics_data.lyrics || "";
                    }
                } catch(e) { 
                    // Silent catch, 404 or timeout means no lyrics
                }

                await dbConn.execute(song_sql, [song_id, name, artist, album, JSON.stringify(genres), JSON.stringify(af), lyrics, popularity, explicit, release_date]);
                await dbConn.execute('INSERT IGNORE INTO playlist_songs (playlist_id, song_id) VALUES (?, ?)', [playlist_id, song_id]);
            }
        }
        
        //
        // success, return playlist_id:
        //
        await dbConn.commit();
        console.log(`done, retrieved playlist id ${playlist_id}`);

        return playlist_id;
        }
        catch (err) {
        //
        // exception:
        //
        console.log("ERROR in try_post_playlist:");
        console.log(err.message);
        try { await dbConn.rollback(); } catch(err) { /*ignore*/ }

        throw err;  // re-raise exception to trigger retry mechanism

        }
        finally {
        //
        // close connection:
        //
        try { await dbConn.end(); } catch(err) { /*ignore*/ }
        }
    }

  //
  // retry the inner function at most 3 times:
  //
  try {
    console.log("**Call to post /playlist...");

    let playlist_id = await pRetry( () => try_post_playlist(), {retries: 2} );

    //
    // success, return data in JSON format:
    //
    console.log("success, sending response...");

    response.json({
      "message": "success",
      "playlist_id": playlist_id,
    });
  }
  catch (err) {
    //
    // exception:
    //
    console.log("ERROR:");
    console.log(err.message);

    //
    // if an error occurs it's our fault, so use status code
    // of 500 => server-side error:
    //

    let error_code = err.status_code || 500;

    response.status(error_code).json({
      "message": err.message,
      "playlist_id": -1,
    });
  }

};
