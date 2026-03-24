//
// API function: post /embeddings
//
// Creates embeddings for all songs in the songs table that don't have one yet.
//
// Author:
//   Jay Rao
//   Northwestern University
//

const mysql2 = require('mysql2/promise');
const { get_dbConn, get_bucket, get_bucket_name, get_bedrock } = require('./helper.js');
//
// p_retry requires the use of a dynamic import:
// const pRetry = require('p-retry');
//
const pRetry = (...args) => import('p-retry').then(({default: pRetry}) => pRetry(...args));
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");


/**
* post_embeddings:
*
* @description selects all songs from the songs table without an s3_key stored for an
* already exisiting embedding, and calls Bedrock Titan to create an embedding vector
* based on the song title, aritst, and album name, and stores it in S3, as well as 
* storing the s3_key in the songs table in the database, and upon success a JSON
* object of the form {message: ..., number_of_songs_processed: ...} is sent where message is
* "success" and number_of_songs_processed is the number of songs processed in the api call
* If an error occurs, a status code of 500 or the given status code by the external APIs
* is sent where the JSON object's message is the error message and number_of_songs_processed is -1. 
*
* @param request 
* @returns JSON {message: string, number_of_songs_processed: int}
*/

exports.post_embeddings = async (request, response) => {

    async function try_post_embeddings() {
        let dbConn;
        try {
        //
        // open connection to database:
        //
        dbConn = await get_dbConn();

        let playlist_sql = `
            SELECT song_id, name, artist, album, genres, audio_features, lyrics, popularity, explicit, release_date
            FROM songs
            WHERE s3_key IS NULL;
            `;       

        let [rows, _] = await dbConn.execute(playlist_sql);

        let song_sql = `
            UPDATE songs
            SET s3_key = ?
            WHERE song_id = ?;
            `;  

        for (let row of rows) {
            let genres_str = "";
            try {
                let g = JSON.parse(row.genres);
                if (g && g.length > 0) genres_str = " with genres including " + g.join(", ");
            } catch(e) {}

            let features_str = "";
            try {
                let f = JSON.parse(row.audio_features);
                if (f) {
                    let traits = [];
                    if (f.danceability > 0.7) traits.push("highly danceable");
                    if (f.energy > 0.7) traits.push("high energy"); else if (f.energy < 0.4) traits.push("mellow");
                    if (f.valence > 0.7) traits.push("happy and positive"); else if (f.valence < 0.4) traits.push("sad or angry");
                    if (f.acousticness > 0.6) traits.push("acoustic");
                    if (traits.length > 0) features_str = ". The vibe is " + traits.join(", ");
                }
            } catch(e) {}

            let lyrics_str = "";
            if (row.lyrics && row.lyrics.trim().length > 0) {
                lyrics_str = `. Some lyrics: "${row.lyrics.substring(0, 200).replace(/\n/g, ' ')}..."`;
            }

            let pop_str = row.popularity > 80 ? ", highly popular" : "";
            let exp_str = row.explicit ? ", explicit" : "";
            let release_str = (row.release_date && row.release_date !== "Unknown") ? ` released in ${row.release_date}` : "";

            let description = `A song titled ${row.name} by the artist ${row.artist} from the album ${row.album}${release_str}${pop_str}${exp_str}${genres_str}${features_str}${lyrics_str}`;
            
            // Run Hugging Face Model Locally!
            if (!global.extractor) {
                const transformers = await import('@xenova/transformers');
                transformers.env.allowLocalModels = false; 
                global.extractor = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
            }

            let output = await global.extractor(description, { pooling: 'mean', normalize: true });
            let embeddingArray = Array.from(output.data);
            let embedding = JSON.stringify(embeddingArray);

            let bucketkey = "embeddings/" + row.song_id + ".json";

            let parameters = {
                Bucket: get_bucket_name(),
                Key: bucketkey,
                Body: embedding,
                };

            let command = new PutObjectCommand(parameters);
            let bucket = get_bucket()
            let promise_s3 = bucket.send(command);
            await promise_s3;

            await dbConn.execute(song_sql, [bucketkey, row.song_id]);

            // Add to the live RAM cache so Vibe Matches can instantly access it!
            global.vector_embeddings.push({
                song_id: row.song_id,
                embedding: embeddingArray
            });
        }
        
        //
        // success, return rows from DB:
        //
        console.log(`done, retrieved ${rows.length} rows`);

        return rows.length;
        }
        catch (err) {
        //
        // exception:
        //
        console.log("ERROR in try_post_embeddings:");
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
    console.log("**Call to post /embeddings...");

    let number_of_songs_processed = await pRetry( () => try_post_embeddings(), {retries: 2} );

    //
    // success, return data in JSON format:
    //
    console.log("success, sending response...");

    response.json({
      "message": "success",
      "number_of_songs_processed": number_of_songs_processed
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
      "number_of_songs_processed": -1,
    });
  }

};
