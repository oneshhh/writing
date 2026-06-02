# Writer/Manager Dashboard (Supabase + Express + Static HTML)

## Folders
- `backend/` Express API that talks to Supabase PostgREST + Storage
- `frontend/` Static HTML/CSS/JS (Supabase Auth in browser + calls backend with bearer token)

## Backend setup
1. Copy `backend/.env.example` to `backend/.env` and fill values.
2. Install deps: `npm --prefix backend install`
3. Run: `npm --prefix backend run dev`

## Frontend setup
1. Edit `frontend/shared/config.js` with your Supabase URL + anon key + API base URL.
2. Serve the `frontend/` folder as static files (nginx or any static server).
