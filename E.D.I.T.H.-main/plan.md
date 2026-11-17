# E.D.I.T.H. — implementation plan

## Product scope
E.D.I.T.H. is a cross-platform, installable communication app for Android and Linux. Users create accounts with unique usernames, discover and add contacts by username, exchange one-to-one messages, and make one-to-one voice or video calls. The app must let a user choose the active microphone and speaker/output device when supported by the browser.

The first release is delivered as an installable Progressive Web App (PWA): Android users can install it from a Chromium-based browser and Linux users can install it from Chrome/Edge or run it as a desktop web app. The application code is Python-first: FastAPI provides the server, authentication, persistence, WebSocket signaling, and static delivery; browser WebRTC handles encrypted peer-to-peer media without routing audio/video through the Python server.

## Architecture and implementation
- **Backend:** Python 3.11+, FastAPI, Uvicorn, SQLite by default. The database schema stores users, sessions, contacts, conversations, messages, and call history. Passwords are salted and hashed with PBKDF2-HMAC-SHA256; session tokens are random, database-backed, and stored in HttpOnly cookies.
- **Realtime:** A FastAPI WebSocket endpoint authenticates from the session cookie and broadcasts new messages and WebRTC signaling envelopes to connected users. WebRTC uses configurable STUN/TURN servers from `ICE_SERVERS_JSON`, with a public STUN fallback for development.
- **Frontend:** Server-served HTML/CSS/vanilla JavaScript keeps the runtime small and installable. The client provides auth screens, contact search/add, conversation history, optimistic message sending, online presence, incoming-call modal, voice/video call controls, microphone and speaker selectors, and responsive layouts.
- **Installability:** `manifest.webmanifest`, a service worker, a maskable icon derived from the supplied logo, and offline shell caching make the app installable on Android and Linux. Real-time functions require network access; the UI makes that boundary explicit.
- **Deployment:** `Dockerfile` runs the Python app on `PORT` (default 3000). `GET /healthz` is unauthenticated for container health. `GET /manus-routes.json` declares the page route for Webdev.

## Project structure
- `app.py`: FastAPI application, auth, database access, REST endpoints, WebSocket manager, and static serving.
- `templates/index.html`: Single responsive application shell.
- `static/app.js`: Auth state, API client, WebSocket handling, contact/conversation UI, device selection, and WebRTC call lifecycle.
- `static/styles.css`: HUD-inspired responsive visual system.
- `static/manifest.webmanifest`, `static/sw.js`: installable PWA metadata and offline shell cache.
- `static/edith-logo.jpeg`, `static/icon-*.png`: supplied branding and install icons.
- `requirements.txt`, `Dockerfile`, `.env.example`: reproducible runtime and deployment setup.
- `README.md`: setup, deployment, PWA installation, TURN configuration, and security notes.

## Design direction
Three possible directions: **Tactical HUD / near-future command console** (0.07); **Quiet dark glass communications studio** (0.05); **Electric editorial network map** (0.03).

Chosen direction: **Tactical HUD / near-future command console**, using the supplied cyan circular logo as the anchor.

- **Design movement:** Near-future interface design inspired by aircraft instrumentation and cybernetic control rooms, translated into a calm communication tool rather than a noisy game UI.
- **Core principles:** fast scanning, confident hierarchy, high contrast, and visible system state.
- **Color philosophy:** deep navy and blue-black surfaces create a quiet field for conversations; cyan signals activity, trust, and connection; amber is reserved for attention and call-state warnings.
- **Layout paradigm:** a persistent command rail and narrow contacts column frame a large conversation workbench, with call controls appearing as a floating communications layer rather than a separate page.
- **Signature elements:** cyan hairline borders, soft radial glows behind live status, and micro-labels that make presence/call state feel instrumented.
- **Interaction philosophy:** every action returns immediate state feedback; destructive or high-consequence actions are explicit, while navigation stays one gesture away.
- **Animation:** restrained 150–220ms transitions, subtle pulsing only for online/live-call state, and no decorative motion that competes with message reading.
- **Typography system:** Inter/system sans for readable body copy with compact uppercase micro-labels and tabular numerals for timestamps and device state.
- **Brand essence:** a private communications console for people who want direct, capable, low-friction connection; precise, luminous, composed.
- **Brand voice:** concise and operational. Example lines: “CHANNEL SECURED.” and “SELECT A CONTACT TO OPEN A LIVE THREAD.”
- **Wordmark & logo:** the supplied circular cyan HUD mark sits beside the spaced `E.D.I.T.H.` wordmark; the icon remains recognizable at small sizes through a dark square background and cyan edge glow.
- **Signature brand color:** `#86f7ff`, an icy cyan that reads as ownable against the app’s navy field.

## Material constraints
The supplied logo is reused without searching for a replacement. The app does not claim PSTN-grade calling: voice/video quality depends on device permissions, browser support, connectivity, and TURN configuration. A production deployment should provide a TURN service and HTTPS.
