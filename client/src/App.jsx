import { useState, useEffect, useRef } from 'react';

const CLIENT_ID = import.meta.env.VITE_CLIENT_ID;
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080';
const REDIRECT_URI = import.meta.env.VITE_REDIRECT_URI || 'https://localtest.me:5173/callback';
const SCOPES = 'playlist-read-private playlist-read-collaborative playlist-modify-private playlist-modify-public';

const generateRandomString = (length) => {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(length));
  return values.reduce((acc, x) => acc + possible[x % possible.length], "");
}

const sha256 = async (plain) => {
  const encoder = new TextEncoder()
  const data = encoder.encode(plain)
  return window.crypto.subtle.digest('SHA-256', data)
}

const base64encode = (input) => {
  return btoa(String.fromCharCode(...new Uint8Array(input)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function App() {
  const [token, setToken] = useState('');
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylists, setSelectedPlaylists] = useState(new Set());
  const [vibe, setVibe] = useState('');
  const [numSongs, setNumSongs] = useState(50);
  const [playlistName, setPlaylistName] = useState('');
  const [loading, setLoading] = useState(false);
  const [matches, setMatches] = useState([]);
  const [statusMsg, setStatusMsg] = useState('');
  const [view, setView] = useState('login');
  const authAttempted = useRef(false);

  useEffect(() => {
    // Check URL params for code
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    let localToken = window.localStorage.getItem('token');

    const authenticate = async () => {
        let codeVerifier = window.localStorage.getItem('code_verifier');
        console.log("Exchanging code for token. code_verifier exists:", !!codeVerifier);
        const payload = {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
                code_verifier: codeVerifier,
            }),
        };
        try {
            const body = await fetch('https://accounts.spotify.com/api/token', payload);
            const response = await body.json();
            console.log("Token exchange full response:", JSON.stringify(response));
            if (response.access_token) {
                window.localStorage.setItem('token', response.access_token);
                window.localStorage.removeItem('code_verifier');
                window.history.replaceState({}, document.title, "/"); 
                setToken(response.access_token);
                setView('dashboard');
                fetchPlaylists(response.access_token);
            } else {
                console.error("Auth error: ", response);
                // Clean up stale data so we don't get stuck
                window.localStorage.removeItem('token');
                window.localStorage.removeItem('code_verifier');
                window.history.replaceState({}, document.title, "/");
                setView('login');
            }
        } catch (e) {
            console.error(e);
            window.localStorage.removeItem('token');
            window.localStorage.removeItem('code_verifier');
            window.history.replaceState({}, document.title, "/");
            setView('login');
        }
    };

    if (code) {
        // Guard against React Strict Mode double-firing
        if (authAttempted.current) return;
        authAttempted.current = true;
        window.localStorage.removeItem('token');
        authenticate();
    } else if (localToken) {
        setToken(localToken);
        setView('dashboard');
        fetchPlaylists(localToken);
    }
  }, []);

  useEffect(() => {
    if (view === 'results') {
      document.body.classList.add('no-bg-blur');
    } else {
      document.body.classList.remove('no-bg-blur');
    }
  }, [view]);

  const loginWithSpotify = async () => {
    const codeVerifier = generateRandomString(64);
    const hashed = await sha256(codeVerifier);
    const codeChallenge = base64encode(hashed);

    window.localStorage.setItem('code_verifier', codeVerifier);

    const authUrl = new URL("https://accounts.spotify.com/authorize")
    const params = {
      response_type: 'code',
      client_id: CLIENT_ID,
      scope: SCOPES,
      code_challenge_method: 'S256',
      code_challenge: codeChallenge,
      redirect_uri: REDIRECT_URI,
      show_dialog: 'true',
    }

    authUrl.search = new URLSearchParams(params).toString();
    window.location.href = authUrl.toString();
  };

  const logout = () => {
    setToken('');
    window.localStorage.removeItem('token');
    setView('login');
  };

  const fetchPlaylists = async (accessToken) => {
    try {
        setStatusMsg('Loading playlists...');
        const res = await fetch(`${API_BASE}/playlists?token=${accessToken}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to load playlists");
        setStatusMsg('');
        setPlaylists(data.playlists || []);
    } catch (e) {
        console.error("Failed to fetch playlists", e);
        setStatusMsg('Failed to load playlists. Try refreshing.');
    }
  };

  const togglePlaylist = (id) => {
    const newSelected = new Set(selectedPlaylists);
    if (newSelected.has(id)) newSelected.delete(id);
    else newSelected.add(id);
    setSelectedPlaylists(newSelected);
  };

  const generateVibePlaylist = async () => {
    if (selectedPlaylists.size === 0) return alert('Select at least one playlist!');
    if (!vibe) return alert('Please enter a vibe description!');
    
    setLoading(true);
    let success = false;
    try {
      // 1. Sync
      for (let pid of selectedPlaylists) {
          setStatusMsg(`Scanning & Syncing Playlist Data...`);
          let sRes = await fetch(`${API_BASE}/playlist`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ playlist_id: pid, access_token: token })
          });
          if (sRes.status === 401) { logout(); return alert("Session expired: please log in again."); }
          if (!sRes.ok) throw new Error("Sync failed for " + pid);
      }
      
      // 2. Embeddings
      setStatusMsg('Analyzing tracks with Local AI...');
      let eRes = await fetch(`${API_BASE}/embeddings`, { method: 'POST' });
      if (!eRes.ok) throw new Error("Embeddings AI generation failed");

      // 3. Match
      setStatusMsg('Matching your vibe against your library...');
      const res = await fetch(`${API_BASE}/vibe_matches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: vibe,
          playlist_ids: Array.from(selectedPlaylists),
          limit: parseInt(numSongs) || 50
        })
      });
      
      if (!res.ok) {
          try { let e = await res.json(); throw new Error(e.message); } 
          catch(e) { throw new Error("Server error " + res.status); }
      }

      const data = await res.json();
      if (data.top_50_songs && data.top_50_songs.length > 0) {
        setMatches(data.top_50_songs);
        setView('results');
        success = true;
      } else {
        alert("Failed to find matches or no mapped songs returned!");
      }
    } catch (e) {
      console.error(e);
      alert(e.message);
    } finally {
      setLoading(false);
      if(!success) setStatusMsg('');
    }
  };


  const exportToSpotify = async () => {
    if(matches.length === 0) return;
    setLoading(true);
    setStatusMsg("Exporting to Spotify via server...");
    try {
        const res = await fetch(`${API_BASE}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                access_token: token,
                vibe_name: playlistName.trim(),
                track_ids: matches.map(m => m.song_id)
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Export failed");
        
        setStatusMsg("");
        alert(`Playlist exported successfully! Open Spotify and look for "${playlistName.trim()}".`);
    } catch(e) {
        console.error(e);
        setStatusMsg("");
        alert("Error exporting: " + e.message);
    } finally {
        setLoading(false);
    }
  };


  if (view === 'login') {
    return (
      <div className="app-container" style={{justifyContent: 'center', alignItems: 'center'}}>
        <div className="glass-panel login-view">
          <svg className="logo-glow" viewBox="0 0 24 24" fill="var(--primary)"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.6 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.84.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.6.18-1.2.72-1.38 4.2-1.26 11.28-1.02 15.721 1.62.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>
          <h1>vibes.fm</h1>
          <p>Create the perfect playlist by deeply analyzing the semantic vibe of your Spotify library.</p>
          <br />
          <button className="btn-primary" onClick={loginWithSpotify}>
            Login to Spotify
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {view === 'dashboard' && (
        <div className="glass-panel dashboard">
          <div>
            <h2>1. Select Playlists</h2>
            <p style={{marginBottom: '1rem'}}>Choose the playlists you want to draw songs from.</p>
            <div className="playlists-container">
              {playlists.map(pl => (
                <div 
                  key={pl.id} 
                  className={`playlist-card ${selectedPlaylists.has(pl.id) ? 'selected' : ''}`}
                  onClick={() => togglePlaylist(pl.id)}
                >
                  <img src={pl.images?.[0]?.url || 'https://via.placeholder.com/50'} alt="cover" />
                  <div className="playlist-info">
                    <h4>{pl.name || "Unknown"}</h4>
                    <p>{pl.items?.total !== undefined ? pl.items.total : (pl.items?.length ?? '?')} songs</p>
                  </div>
                </div>
              ))}
            </div>
            {statusMsg && <p style={{marginTop: '10px', fontSize: '0.9rem', color: 'var(--primary)'}}>{statusMsg}</p>}
          </div>

          <div>
            <h2>2. Define Your Vibe</h2>
            <p style={{marginBottom: '1rem'}}>Be as specific or vague as you want. The AI matrix will match it to your library.</p>
            <div style={{ display: 'flex', gap: '10px', marginBottom: '10px'}}>
               <input 
                 type="number" 
                 className="no-spin"
                 value={numSongs} 
                 onChange={e => setNumSongs(e.target.value)} 
                 min="1" max="100" 
                 style={{width: '70px', padding: '10px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.05)', color: '#fff'}}
               /> <span style={{display: 'flex', alignItems: 'center'}}>Max Songs</span>
            </div>
            <textarea 
              className="vibe-input" 
              rows="4"
              placeholder="Describe the vibe you're looking for..."
              value={vibe}
              onChange={e => setVibe(e.target.value)}
            />
            <button className="btn-primary" style={{width: '100%'}} onClick={generateVibePlaylist} disabled={loading}>
                 {loading ? 'Generating...' : 'Generate Playlist'}
            </button>
            <br/><br/>
            <button className="btn-secondary" onClick={logout}>Sign Out</button>
          </div>
        </div>
      )}

      {view === 'results' && (
        <div className="glass-panel">
          <div className="results-header" style={{flexDirection: 'column', alignItems: 'flex-start', gap: '15px'}}>
            <div style={{width: '100%'}}>
              <h2 style={{marginBottom: '5px'}}>Your Vibe Playlist</h2>
              <p>Matched "{vibe}"</p>
            </div>
            <div className="results-action-row" style={{display: 'flex', gap: '12px', width: '100%', flexWrap: 'wrap'}}>
              <input 
                 type="text" 
                 className="title-input"
                 value={playlistName} 
                 onChange={e => setPlaylistName(e.target.value)} 
                 placeholder="Name your new playlist..." 
                 style={{flexGrow: 1, padding: '12px 15px', borderRadius: '8px', minWidth: '220px'}}
              />
              <button className="btn-secondary" onClick={() => setView('dashboard')}>Back</button>
              <button className="btn-primary" disabled={loading || !playlistName.trim()} onClick={exportToSpotify}>Export to Spotify</button>
            </div>
          </div>
          <div className="song-list">
            {matches.map((song, i) => (
              <div className="song-item" key={i}>
                <div className="song-number">{i + 1}</div>
                <div className="song-details">
                  <h4>{song.name}</h4>
                  <p>{song.artist} • {song.album}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && (
        <div style={{position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', zIndex: 100, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center'}}>
          <div className="loader"></div>
          <p style={{marginTop: '10px', fontWeight: '600'}}>{statusMsg}</p>
        </div>
      )}
    </div>
  );
}

export default App;
