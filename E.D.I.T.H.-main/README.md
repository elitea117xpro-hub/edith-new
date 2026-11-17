# E.D.I.T.H.

E.D.I.T.H. is a Python-first, installable communication console for Android and Linux. It combines username-based accounts, direct contacts, persistent one-to-one text threads, and one-to-one WebRTC voice/video calls in a focused HUD-inspired interface using the supplied cyan circular logo.

## What is included

The FastAPI server in `app.py` provides account creation, sign-in/out, secure cookie sessions, username search, contact management, SQLite persistence, message history, WebSocket message delivery, WebRTC signaling, call history, and a health endpoint. The browser client is vanilla JavaScript so the project stays easy to run and install. WebRTC media is peer-to-peer; the Python server carries signaling only.

The app is an installable PWA. On Android, open the HTTPS deployment in Chrome and use the browser's “Install app” or “Add to Home screen” action. On Linux, use Chrome/Edge's install icon in the address bar or “Install E.D.I.T.H.” inside the app. Messaging and call controls require the app to be online after the shell is installed.

## Run locally

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # optional; export values from it in your shell
uvicorn app:app --reload --host 0.0.0.0 --port 3000
```

Open `http://localhost:3000`. Create two accounts in separate browser profiles to exercise messaging and calling. The default database is `data/edith.db`; set `EDITH_DB_PATH` to move it.

## Production deployment

The included `Dockerfile` listens on `PORT` and the unauthenticated readiness endpoint is `/healthz`.

```bash
docker build -t edith .
docker run --rm -p 3000:3000 \
  -e ICE_SERVERS_JSON='[{"urls":["stun:stun.example.com:3478","turn:turn.example.com:3478"],"username":"turn-user","credential":"turn-password"}]' \
  edith
```

For reliable calls across different networks, deploy behind HTTPS and configure a TURN server. The `ICE_SERVERS_JSON` environment variable is exposed only by `/api/config` and should contain the ICE server configuration intended for clients. Use short-lived or scoped TURN credentials for production.

## Device permissions

Microphone and camera permission is requested only when a voice or video link is initiated or accepted. The Devices view lists available microphones and speaker outputs. Microphone routing uses `getUserMedia` device constraints. Speaker routing uses `HTMLMediaElement.setSinkId()` when the browser supports it; otherwise E.D.I.T.H. explains that the system default will be used.

## Security and operational notes

Use HTTPS in production because browser media permissions and service workers require a secure context. Passwords are salted PBKDF2-HMAC-SHA256 hashes and are never sent back to the client. Session cookies are HttpOnly and use `SameSite=None; Secure` when the app is reached through HTTPS, which also keeps the embedded managed Preview login flow working. The default SQLite database is suitable for a single instance; move to a managed relational database and shared session store before horizontally scaling. The provided server intentionally does not store raw audio or video.

## Repository layout

`app.py` is the backend; `templates/index.html`, `static/app.js`, and `static/styles.css` are the UI; `static/manifest.webmanifest` and `static/sw.js` make the app installable; `plan.md` records the implementation and visual direction; `TODO.md` records requirement outcomes; and `Dockerfile` plus `requirements.txt` provide reproducible deployment.
