//
// spotify_vibes helper functions
//
// Initial author:
//   Prof. Joe Hummel
//   Northwestern University
//
//  Edited by Jay Rao

const fs = require('fs');
const ini = require('ini');
const config = require('./config.js');
const mysql2 = require('mysql2/promise');
const { S3Client } = require('@aws-sdk/client-s3');
const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
const { fromIni } = require('@aws-sdk/credential-providers');


/** 
 * async get_dbConn
 *
 * @description Reads config info and opens connection to MySQL server.
 * Returns dbConn object to use for executing queries against the
 * database; you should close the connection via .end() when done.
 * Throws an exception if an error occurs.
 *
 * NOTE: this is an async function, which returns a promise. You
 * must await return_value to properly wait for the connection to
 * be established and resolve the promise. 
 *
 * @param none
 * @returns {Promise<Connection>} dbConn connection object
 * @throws {Exception} if an error occurs
 */
async function get_dbConn()
{
  const config_data = fs.readFileSync(config.spotify_vibes_config_filename, 'utf-8');
  const spotify_vibes_config = ini.parse(config_data);
  const endpoint = spotify_vibes_config.rds.endpoint;
  const port_number = spotify_vibes_config.rds.port_number;
  const user_name = spotify_vibes_config.rds.user_name;
  const user_pwd = spotify_vibes_config.rds.user_pwd;
  const db_name = spotify_vibes_config.rds.db_name;

  //
  // creates and open connection to MySQL server:
  //
  let dbConn = mysql2.createConnection(
    {
      host: endpoint,
      port: port_number,
      user: user_name,
      password: user_pwd,
      database: db_name,
      multipleStatements: true  // allow multiple queries in one call
    }
  );
  
  return dbConn;
}


/** 
 * sync get_bucket
 *
 * @description Reads config info and returns an object you can use
 * to interact with S3 storage service. No need to explicitly open 
 * or close the connection to S3. Throws an exception on an error.
 *
 * NOTE: this is a synchronous function using AWS's boto library,
 * no need to await for a connection to be established.
 *
 * @param none
 * @returns {Bucket} S3 bucket object
 * @throws {Exception} if an error occurs
 */
function get_bucket()
{
  const config_data = fs.readFileSync(config.spotify_vibes_config_filename, 'utf-8');
  const spotify_vibes_config = ini.parse(config_data);
  const s3_region_name = spotify_vibes_config.s3.region_name;

  let bucket = new S3Client({
    region: s3_region_name,
    maxAttempts: 3,
    defaultsMode: "standard",
    credentials: fromIni({ profile: config.spotify_vibes_s3_profile })
  });

  return bucket;
}


/** 
 * sync get_bucket_name
 *
 * @description Reads config info and returns the name of the 
 * S3 bucket. Throws an exception on an error.
 *
 * NOTE: this is a synchronous function using AWS's boto library,
 * no need to await for a connection to be established.
 *
 * @param none
 * @returns {string} S3 bucket name
 * @throws {Exception} if an error occurs
 */
function get_bucket_name()
{
  const config_data = fs.readFileSync(config.spotify_vibes_config_filename, 'utf-8');
  const spotify_vibes_config = ini.parse(config_data);
  const s3_bucket_name = spotify_vibes_config.s3.bucket_name;

  return s3_bucket_name;
}

/** 
 * sync get_bedrock
 *
 * @description Reads config info and returns an object you can use
 * to interact with Bedrock service. Throws an exception on an error.
 *
 * @param none
 * @returns {bedrock}  Bedrock object
 * @throws {Exception} if an error occurs
 */
function get_bedrock()
{
  const config_data = fs.readFileSync(config.spotify_vibes_config_filename, 'utf-8');
  const spotify_vibes_config = ini.parse(config_data);
  const bedrock_region_name = spotify_vibes_config.bedrock.region_name;

  let bedrock = new BedrockRuntimeClient({
    region: bedrock_region_name,
    maxAttempts: 3,
    defaultsMode: "standard",
    credentials: fromIni({ profile: config.spotify_vibes_bedrock_profile })
  });

  return bedrock;
}

/** 
 * sync get_spotify
 *
 * @description Reads config info and returns an object you can use
 * to interact with Spotify service. Throws an exception on an error.
 *
 * @param none
 * @returns {spotify}  Spotify object
 * @throws {Exception} if an error occurs
 */
function get_spotify()
{
  const config_data = fs.readFileSync(config.spotify_vibes_config_filename, 'utf-8');
  const spotify_vibes_config = ini.parse(config_data);
  
  const client_id = spotify_vibes_config.spotify_developer.client_id
  const client_secret = spotify_vibes_config.spotify_developer.client_secret
  const refresh_token = spotify_vibes_config.spotify_developer.refresh_token

  return {
    client_id: client_id,
    client_secret: client_secret,
    refresh_token: refresh_token
  }
}


//
// list the functions we are exporting:
//
module.exports = { get_dbConn, get_bucket, get_bucket_name, get_bedrock, get_spotify };
