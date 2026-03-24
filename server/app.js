//
// Spotify-Vibes web service based on Node.js and Express. This file
// contains the main function that starts and listens on the
// configured network port. The remaining API functions are 
// defined in separate JS files for easier development.
//
// Authors:
//  Jay Rao
//  Prof. Joe Hummel (initial template)
//  Northwestern University
//
// References:
// Node.js: 
//   https://nodejs.org/
// Express: 
//   https://expressjs.com/
// MySQL2: 
//  https://sidorares.github.io/node-mysql2/docs
// AWS SDK with JS:
//   https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/index.html
//   https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/getting-started-nodejs.html
//   https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-s3/
//   https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html
//

global.vector_embeddings = [];

const express = require('express');
const app = express();
const config = require('./config.js');
const { get_dbConn, get_bucket, get_bucket_name } = require('./helper.js');
const { GetObjectCommand } = require("@aws-sdk/client-s3");

// support larger uploads/downloads:
app.use(express.json({ strict: false, limit: "50mb" }));

// CORS — allow requests from the Vercel frontend (and localhost for local dev)
app.use((req, res, next) => {
  const allowed = [
    'http://localhost:5173',
    'https://localtest.me:5173',
    process.env.FRONTEND_URL  // set this on EC2 to your Vercel URL
  ].filter(Boolean);
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});



/**
 * main:
 *
 * @description startup code for web service, starts listening on port
 * @param none
 * @returns none
 */
var startTime;

app.listen(config.web_service_port, () => {
  startTime = Date.now();
  console.log(`**Web service running, listening on port ${config.web_service_port}...`);
  //
  // Configure AWS to use our config file:
  //
  process.env.AWS_SHARED_CREDENTIALS_FILE = config.spotify_vibes_config_filename;
});


/**
 * get /
 * 
 * @description handles request for what would be default page as if
 * we were a web server. Returns startus and how long the service has
 * been up and running (seconds).
 * 
 * @param request
 * @param response
 * @returns {status: string, uptime_in_seconds: integer}
 */
app.get('/', (request, response) => {
  try {
    console.log("**Call to /...");
    
    let uptime = Math.round((Date.now() - startTime) / 1000);

    console.log("sending response...");

    response.json({
      "status": "running",
      "uptime_in_secs": uptime,
    });
  }
  catch(err) {
    console.log("ERROR:");
    console.log(err.message);

    //
    // if something goes wrong it's our fault, ==> use a
    // status code of 500 ==> server-side error:
    //
    response.status(500).json({
      "status": err.message,
      "uptime_in_secs": uptime,
    });
  }
});

async function load_embeddings() {
    let dbConn = await get_dbConn();
    try {
      let sql = `
          SELECT song_id, s3_key
          FROM songs;
          `; 

      let [rows, _] = await dbConn.execute(sql);

      for (let row of rows) {
        try{
          let parameters = {
              Bucket: get_bucket_name(),
              Key: "embeddings/" + row.song_id + ".json"
          };

          let command = new GetObjectCommand(parameters);
          let bucket = get_bucket()
          let promise_s3 = bucket.send(command);
          let result_s3 = await promise_s3; 
          let result_s3_as_string = await result_s3.Body.transformToString();
          let embedding = JSON.parse(result_s3_as_string);

          let song = {
            song_id: row.song_id,
            embedding: embedding,
          };

          global.vector_embeddings.push(song);
        }
        catch (err) {
          console.log("skipping 1 song without file");
        }
      }
      console.log("Cached all song embeddings");
    }
  catch (err) {
    console.log("Failed to cache vibe embeddings for each song");
    console.log(err.message);
  }
  finally {
      try { await dbConn.end(); } catch(err) { /*ignore*/ }
  }
  
}

//
// web service API functions, one per JS file:
//
//

let post_playlist_file = require('./api_post_playlist.js');
app.post('/playlist', post_playlist_file.post_playlist);

let post_embeddings_file = require('./api_post_embeddings.js');
app.post('/embeddings', post_embeddings_file.post_embeddings);

let post_vibe_matches_file = require('./api_post_vibe_matches.js');
app.post('/vibe_matches', post_vibe_matches_file.post_vibe_matches);

let post_export_file = require('./api_post_export.js');
app.post('/export', post_export_file.post_export);

let get_playlists_file = require('./api_get_playlists.js');
app.get('/playlists', get_playlists_file.get_playlists);


// Call the embedding caching as well

load_embeddings();