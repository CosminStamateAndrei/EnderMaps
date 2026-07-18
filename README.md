# EnderMaps

A real-world map that renders like the in-game map from a certain blocky sandbox game. Built with React + Vite + Leaflet, using OpenStreetMap tiles.

## Features
- Chunky pixelated map tiles (real OSM data, stretched into fat texels)
- F3-style debug HUD: live block coordinates (X/Y/Z), chunk coords, and a biome guess
- Chat-bar search powered by Nominatim (`/locate` any place on Earth)
- "Locate me" drops a white player arrow at your GPS position
- Day/Night toggle
- Zero image assets — every texture and icon is CSS or inline SVG

## Run locally
```bash
npm install
npm run dev
```

## Deploy to Vercel
1. Push this folder to a GitHub repo.
2. On vercel.com, click **Add New → Project** and import the repo.
3. Vercel auto-detects Vite. Just click **Deploy** — no config needed.

Or from the command line:
```bash
npm i -g vercel
vercel
```

## Notes
- Map data © OpenStreetMap contributors (attribution is kept in the corner — please leave it there, it's required by their license).
- Nominatim (the search API) is free but rate-limited; for heavy traffic, switch to a hosted geocoder.
