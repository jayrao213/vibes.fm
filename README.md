# vibes.fm

### **[vibesfm.vercel.app](https://vibesfm.vercel.app)**

An AI-powered playlist generator that turns natural language descriptions into real Spotify playlists, built entirely from scratch with a React frontend and a Node.js backend running on AWS.

You tell it a vibe. It reads your entire Spotify library, computes the semantic meaning of every song using a local Hugging Face sentence-transformer model, compares that against your prompt using cosine similarity, and hands you back a ranked playlist of the best-matching tracks. One click and that playlist is exported directly to your Spotify account.

---

## How It Works

### The User Flow

1. **Login** -- You authenticate with Spotify through a secure PKCE OAuth 2.0 flow. No passwords are ever stored. The app requests read access to your playlists and write access to create new ones.

2. **Select Playlists** -- After login, all your Spotify playlists are displayed with their cover art and song counts. You pick whichever ones you want the AI to pull songs from. You can select one, a few, or all of them.

3. **Describe Your Vibe** -- A big open text box. Type anything. "late night drive through empty highways with the windows down" or "energy for a 6am gym session" or "songs that sound like rain on a tin roof." The AI interprets the semantic meaning of what you wrote, not just keywords.

4. **Generate** -- The app syncs your selected playlists into the database, builds rich text descriptions for every track, runs them through a sentence-transformer embedding model, and then ranks every song against your prompt using cosine similarity. The top matches come back as your playlist.

5. **Name and Export** -- You type a name for your new playlist, hit Export, and the server creates it in your Spotify account with all the matched tracks. Open Spotify and it is right there.

---

## The AI Pipeline

This is the core of the project and the part worth understanding in detail.

### Step 1: Song Description Construction

When a playlist is synced, the server fetches every track from the Spotify API and stores it in an AWS RDS MySQL database. For each song, it also fetches:

- **Audio features** from Spotify (danceability, energy, valence, acousticness)
- **Artist genres** from Spotify's artist endpoint
- **Lyrics** from lyrics.ovh (with a 2-second timeout to avoid blocking on missing data)

All of this is combined into a single rich natural language description per song. For example:

```
A song titled Starboy by the artist The Weeknd from the album Starboy released in
2016-11-25, highly popular, explicit with genres including canadian contemporary r&b,
canadian pop, pop. The vibe is high energy, happy and positive.
Some lyrics: "I'm tryna put you in the worst mood, ah / P1 cleaner than your church shoes, ah..."
```

This description is specifically designed to capture not just metadata, but the emotional and sonic character of the song in natural language -- exactly the kind of language a user would use to describe a vibe.

### Step 2: Embedding Generation

Each song description is run through **Hugging Face's `all-MiniLM-L6-v2` sentence-transformer model**, loaded locally on the server via `@xenova/transformers`. No external API calls for embeddings -- everything runs on-device.

The model produces a 384-dimensional normalized vector for each song. These vectors are stored as JSON files in an **AWS S3** bucket, with references tracked in the MySQL database.

When the server starts up, it loads every single embedding from S3 into an in-memory cache (`global.vector_embeddings`). This means vibe matching runs in pure RAM with zero I/O latency during a search.

### Step 3: Vibe Matching

When you submit a vibe prompt, the same `all-MiniLM-L6-v2` model encodes your text into a 384-dimensional vector. The server then computes the **dot product** (equivalent to cosine similarity on normalized vectors) between your prompt vector and every song vector in RAM.

Songs are ranked by similarity score, and the top N (default 50, configurable up to 100) are returned to the frontend with their metadata.

If you selected specific playlists, only songs from those playlists are considered. This is handled by a SQL join against the `playlist_songs` mapping table before the vector search begins.

---

## Architecture

```
Browser (React)                    EC2 (Node.js + Express)
vibesfm.vercel.app                 vibesfm.duckdns.org
     |                                    |
     |--- PKCE OAuth --> Spotify -------->|
     |                                    |
     |--- GET /playlists ---------------->| --> Spotify API
     |--- POST /playlist ---------------->| --> Spotify API --> RDS MySQL
     |--- POST /embeddings -------------->| --> Transformers.js --> S3
     |--- POST /vibe_matches ------------>| --> Transformers.js + RAM cache --> RDS
     |--- POST /export ------------------>| --> Spotify API (create playlist + add tracks)
     |                                    |
     |       AWS RDS MySQL               AWS S3
     |      (song metadata,         (embedding vectors
     |       audio features,          as JSON files)
     |       genres, lyrics)
```

### Frontend

- **React 18** with Vite as the build tool
- Single-file app (`App.jsx`) managing three views: login, dashboard, and results
- **PKCE OAuth 2.0** for Spotify authentication (SHA-256 code challenge, no client secret exposed)
- All API calls go to the backend via `VITE_API_URL` environment variable
- Mobile-responsive CSS with glassmorphism design, custom scrollbars, and smooth animations
- Deployed on **Vercel** with SPA rewrite rules for client-side routing

### Backend

- **Node.js 22** with **Express 5**
- Six API endpoints, each in its own file for clean separation
- **AWS RDS MySQL** for persistent storage of songs, playlists, audio features, genres, and lyrics
- **AWS S3** for embedding vector storage and retrieval
- **Transformers.js** (`@xenova/transformers`) for local sentence-transformer inference
- In-memory embedding cache loaded from S3 on startup for sub-millisecond vector search
- **PM2** process manager for auto-restart and crash recovery
- **nginx** reverse proxy with **Let's Encrypt SSL** via certbot
- Deployed on **AWS EC2** (t3.micro, Ubuntu 22.04)

---

## API Endpoints

### `GET /`
Health check. Returns server status and uptime in seconds.

### `GET /playlists?token=<access_token>`
Fetches all of the authenticated user's Spotify playlists via the Spotify Web API. Handles pagination automatically (50 per page) and includes built-in retry logic for Spotify's rate limiting (429 responses with Retry-After header parsing).

### `POST /playlist`
Syncs a single Spotify playlist into the database. For each track, it:
- Fetches audio features (danceability, energy, valence, acousticness, etc.)
- Fetches artist genres
- Fetches lyrics from lyrics.ovh with a 2-second timeout
- Inserts the song into the `songs` table and maps it in `playlist_songs`
- Handles differential sync: detects songs added or removed since the last sync

Request body: `{ playlist_id, access_token }`

### `POST /embeddings`
Generates embeddings for all songs in the database that do not yet have one. For each unprocessed song:
- Constructs a rich natural language description from metadata, audio features, genres, and lyrics
- Runs it through the local `all-MiniLM-L6-v2` model
- Stores the resulting 384-dimensional vector as a JSON file in S3
- Records the S3 key in the database
- Adds the vector to the in-memory cache for immediate availability

### `POST /vibe_matches`
The core search endpoint. Takes a natural language description and returns the top matching songs.
- Encodes the user's vibe prompt with the same `all-MiniLM-L6-v2` model
- Computes dot product similarity against every vector in the RAM cache
- Optionally filters to songs from specific playlists only
- Returns the top N songs with name, artist, and album metadata from RDS

Request body: `{ description, playlist_ids[], limit }`

### `POST /export`
Creates a new playlist in the user's Spotify account and populates it with tracks.
- Creates the playlist via `POST /me/playlists` with a custom name and "Generated by vibes.fm" description
- Adds tracks in batches of 100 via `POST /playlists/{id}/items`
- Includes fallback logic for Spotify API compatibility

Request body: `{ access_token, vibe_name, track_ids[] }`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite 5, Vanilla CSS |
| Auth | Spotify OAuth 2.0 with PKCE (SHA-256) |
| Backend | Node.js 22, Express 5 |
| AI/ML | Transformers.js (Hugging Face all-MiniLM-L6-v2) |
| Database | AWS RDS MySQL |
| Object Storage | AWS S3 |
| Hosting (Frontend) | Vercel |
| Hosting (Backend) | AWS EC2 (t3.micro, Ubuntu 22.04) |
| Process Manager | PM2 |
| Reverse Proxy | nginx |
| SSL | Let's Encrypt (certbot, auto-renewing) |
| DNS | DuckDNS (free subdomain) |

---

## Project Structure

```
vibes.fm/
├── client/                          # React frontend (Vercel)
│   ├── src/
│   │   ├── App.jsx                  # Main app: auth, sync, search, export
│   │   ├── index.css                # Glassmorphism + responsive styles
│   │   └── main.jsx                 # Entry point
│   ├── index.html                   # HTML shell + meta tags
│   ├── vite.config.js               # Vite config (dev proxy + SSL)
│   ├── vercel.json                  # SPA routing for Vercel
│   ├── .env                         # Local dev secrets (gitignored)
│   ├── .env.production              # Production env vars
│   ├── .npmrc                       # Vercel build fix
│   └── .gitignore
│
└── server/                          # Node.js backend (EC2)
    ├── app.js                       # Express server + embedding cache loader
    ├── config.js                    # Port and file paths
    ├── helper.js                    # AWS + DB client factories
    ├── api_get_playlists.js         # GET /playlists: Fetch from Spotify
    ├── api_post_playlist.js         # POST /playlist: Sync tracks to RDS
    ├── api_post_embeddings.js       # POST /embeddings: Generate vectors
    ├── api_post_vibe_matches.js     # POST /vibe_matches: Semantic search
    ├── api_post_export.js           # POST /export: Create Spotify playlist
    ├── spotify-vibes-config.ini     # AWS + Spotify secrets (gitignored)
    └── .gitignore
```

---

## Local Development

### Prerequisites

- Node.js 22+
- A Spotify Developer App (get a Client ID from [developer.spotify.com](https://developer.spotify.com))
- AWS credentials with access to your RDS instance and S3 bucket
- A `spotify-vibes-config.ini` file in the server directory with your AWS and Spotify credentials

### Running Locally

**Start the backend:**
```bash
cd server
npm install
node app.js
```
The server starts on port 8080 and immediately begins caching song embeddings from S3 into memory.

**Start the frontend:**
```bash
cd client
npm install
npm run dev
```
Vite starts on port 5173 with HTTPS (via `@vitejs/plugin-basic-ssl` for local dev only) and proxies `/api` requests to `localhost:8080`.

**Open the app:**
Navigate to `https://localtest.me:5173` (localtest.me resolves to 127.0.0.1 and provides a valid hostname for Spotify's OAuth redirect).

### Environment Variables (Client)

| Variable | Local Dev | Production |
|----------|-----------|------------|
| `VITE_CLIENT_ID` | Your Spotify Client ID | Same |
| `VITE_API_URL` | `http://localhost:8080` | `https://vibesfm.duckdns.org` |
| `VITE_REDIRECT_URI` | `https://localtest.me:5173/callback` | `https://vibesfm.vercel.app/callback` |

---

## Production Deployment

The app is deployed as two independent services:

### Frontend on Vercel

1. Push the repo to GitHub
2. Import into Vercel, set root directory to `client`
3. Add the three `VITE_*` environment variables in the Vercel dashboard
4. Vercel builds and deploys automatically on every push

### Backend on AWS EC2

1. Launch a `t3.micro` instance with Ubuntu 22.04
2. Install Node.js 22, PM2, and nginx
3. Upload the `server/` directory and `spotify-vibes-config.ini` via SCP
4. Run `npm install` and start with `pm2 start app.js --name vibes-fm`
5. Configure nginx as a reverse proxy to port 8080
6. Install SSL with `certbot --nginx` using a DuckDNS subdomain

### DNS and SSL

A free DuckDNS subdomain (`vibesfm.duckdns.org`) points to the EC2 public IP. Let's Encrypt provides a free auto-renewing SSL certificate via certbot, configured through nginx.

### Spotify Dashboard

Both `https://localtest.me:5173/callback` (local dev) and `https://vibesfm.vercel.app/callback` (production) must be registered as allowed redirect URIs in the Spotify Developer Dashboard.

---

## Database Schema

The MySQL database on RDS contains three core tables:

**`songs`** -- Every unique track across all synced playlists
- `song_id` (Spotify track ID, primary key)
- `name`, `artist`, `album`
- `genres` (JSON array from artist endpoint)
- `audio_features` (JSON object from Spotify audio features endpoint)
- `lyrics` (full text from lyrics.ovh)
- `popularity`, `explicit`, `release_date`
- `s3_key` (path to the embedding JSON file in S3, null if not yet generated)

**`playlists`** -- Tracking table for synced playlists
- `playlist_id` (Spotify playlist ID, primary key)

**`playlist_songs`** -- Many-to-many mapping between playlists and songs
- `playlist_id`, `song_id` (composite key)

---

## Security

- **No client secret in the frontend.** The PKCE flow uses a SHA-256 code challenge and verifier, completely eliminating the need for a client secret in the browser.
- **Secrets are gitignored.** The `.env` file (containing the Spotify Client ID) and `spotify-vibes-config.ini` (containing AWS passwords and Spotify secrets) are both excluded from version control.
- **CORS is locked down.** The backend only accepts requests from explicitly whitelisted origins (localhost for dev, the Vercel URL for production).
- **HTTPS everywhere.** The production frontend is on Vercel (HTTPS by default), the backend uses Let's Encrypt SSL through nginx, and local dev uses a self-signed certificate via Vite's basicSsl plugin.
- **Tokens are short-lived.** Spotify access tokens expire after 1 hour. No refresh token logic is implemented on the frontend -- the user simply re-authenticates.

---

## Author

**Jay Rao**

Northwestern University