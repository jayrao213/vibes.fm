//
// API function: post /vibe_matches
//
// Returns the top 50 songs with the most similar vibe to the input description.
//
// Author:
//   Jay Rao
//   Northwestern University
//

const mysql2 = require('mysql2/promise');
const { get_dbConn, get_bedrock } = require('./helper.js');
//
// p_retry requires the use of a dynamic import:
// const pRetry = require('p-retry');
//
const pRetry = (...args) => import('p-retry').then(({default: pRetry}) => pRetry(...args));
const { InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");


/**
* post_vibe_matches:
*
* @description Takes in an input description from the request body and sends it to 
* Bedrock to get an embedding for it using Titan. Then, this embedding is compared to all
* embeddings of every song using the dot product (as the embeddings are all normalized).
* Then, the song name, arist, and album of the top 50 songs are all retrieved from the databse
* and returned and upon success a JSON object of the form {message: ..., top_50_songs ...} is sent 
* where message is "success" and the top_50_songs is a vector of song objects containing the data for each song.
* If an error occurs, a status code of 500 is sent where the JSON object's message is the error message 
* and an empty array for the top_50_songs.
*
* @param request 
* @returns JSON {message: string}
*/

exports.post_vibe_matches = async (request, response) => {

    async function try_post_vibe_matches() {
        let dbConn;
        try {
        let description = request.body.description;
        let playlist_ids = request.body.playlist_ids; // NEW: optional array of playlist ids
        let limit = request.body.limit || 50;

        // Run Hugging Face Model Locally!
        if (!global.extractor) {
            const transformers = await import('@xenova/transformers');
            transformers.env.allowLocalModels = false; 
            global.extractor = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
        }

        let output = await global.extractor(description, { pooling: 'mean', normalize: true });
        let embedding = Array.from(output.data);

        // open connection to database FIRST so we can fetch allowed songs
        dbConn = await get_dbConn();
        
        // Find allowed song IDs from the provided playlists
        let allowed_song_ids = null; // null means search all
        if (playlist_ids && Array.isArray(playlist_ids) && playlist_ids.length > 0) {
            let placeholders = playlist_ids.map(() => '?').join(',');
            let [rows, _] = await dbConn.execute(`SELECT DISTINCT song_id FROM playlist_songs WHERE playlist_id IN (${placeholders})`, playlist_ids);
            allowed_song_ids = new Set(rows.map(r => r.song_id));
        }

        let cosine_similarities = [];

        for (let song of global.vector_embeddings) {
            // Filter by selected playlists if any are provided
            if (allowed_song_ids && !allowed_song_ids.has(song.song_id)) {
                continue;
            }

            let dot_product = 0;
            for (let i = 0; i < Math.min(embedding.length, song.embedding.length); i++) {
                let product = embedding[i] * song.embedding[i];
                dot_product += product;
            }

            let song_score = {
                song_id: song.song_id,
                score: dot_product,
            };

            cosine_similarities.push(song_score);
        }      
        
        cosine_similarities.sort((a, b) => b.score - a.score);

        let top_50_songs = [];

        let sql = `
            SELECT song_id, name, artist, album
            FROM songs
            WHERE song_id = ?;
            `;    
            
        for (let i = 0; i < Math.min(cosine_similarities.length, limit); i++) {
            let [rows, _] = await dbConn.execute(sql, [cosine_similarities[i].song_id]);
            if (rows.length > 0) {
                let song_data = {
                    song_id: rows[0].song_id,
                    name: rows[0].name,
                    artist: rows[0].artist,
                    album: rows[0].album
                };
                top_50_songs.push(song_data);
            }
        }    
        
        //
        // success, return rows from DB:
        //
        console.log(`done, retrieved 50 songs`);

        return top_50_songs;
        }
        catch (err) {
        //
        // exception:
        //
        console.log("ERROR in try_post_vibe_matches:");
        console.log(err.message);

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
    console.log("**Call to post /vibe_matches...");

    let top_50_songs = await pRetry( () => try_post_vibe_matches(), {retries: 2} );

    //
    // success, return data in JSON format:
    //
    console.log("success, sending response...");

    response.json({
      "message": "success",
      "top_50_songs": top_50_songs
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
      "top_50_songs": []
    });
  }

};
