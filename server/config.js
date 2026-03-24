//
// Defines important app-wide config parameters
//
// Web service configuration parameters, separate from the
// spotify_vibe-config file which contains AWS-specific config
// information (e.g. pwds and access keys which we don't
// want in the code).
//
// Initial template:
//   Prof. Hummel
//   Northwestern University

// Edited by Jay Rao

const config = {
  spotify_vibes_config_filename: "spotify-vibes-config.ini",
  spotify_vibes_s3_profile: "s3readwrite",
  spotify_vibes_bedrock_profile: "bedrock",
  web_service_port: 8080,
  response_page_size: 12
};

module.exports = config;
