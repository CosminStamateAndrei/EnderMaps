import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'

// ---- Overworld math -------------------------------------------------------
// 1 block = 1 meter, like in the game. We project lat/lon onto Web Mercator
// meters so the HUD can show "block coordinates" for the real world.
const R = 6378137
const toBlocks = (lat, lng) => {
  const x = (lng * Math.PI * R) / 180
  const z = -R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))
  return { x: Math.round(x), z: Math.round(z) }
}

const biomeFor = (lat, zoom) => {
  const a = Math.abs(lat)
  if (zoom <= 4) return 'The End (orbit)'
  if (a > 66) return 'Snowy Tundra'
  if (a > 55) return 'Taiga'
  if (a > 40) return 'Forest'
  if (a > 23) return 'Plains'
  if (a > 10) return 'Savanna'
  return 'Jungle'
}

// White pointer, like the player arrow on an in-game map. Drawn inline so we
// ship zero image assets.
const playerIcon = L.divIcon({
  className: 'player-arrow',
  html: `<svg width="28" height="28" viewBox="0 0 14 14" style="image-rendering:pixelated">
    <path d="M7 0 L13 13 L7 10 L1 13 Z" fill="#ffffff" stroke="#3a3a3a" stroke-width="1"/>
  </svg>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
})

const pinIcon = L.divIcon({
  className: 'player-arrow',
  html: `<svg width="26" height="26" viewBox="0 0 13 13" style="image-rendering:pixelated">
    <rect x="5" y="1" width="3" height="8" fill="#c33"/>
    <rect x="4" y="0" width="5" height="3" fill="#e55"/>
    <rect x="5" y="9" width="3" height="3" fill="#5a3d1e"/>
  </svg>`,
  iconSize: [26, 26],
  iconAnchor: [13, 24],
})

export default function App() {
  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const [hud, setHud] = useState({ x: 0, y: 64, z: 0, biome: 'Plains', zoom: 3 })
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [night, setNight] = useState(false)

  useEffect(() => {
    if (mapRef.current) return
    const map = L.map(mapEl.current, {
      center: [44.18, 28.65],
      zoom: 13,
      zoomControl: false,
      worldCopyJump: true,
    })
    mapRef.current = map

    // The chunky-pixel trick: ask OSM for tiles one zoom level lower and
    // stretch them to double size. With image-rendering:pixelated in CSS,
    // every real-world tile turns into fat, blocky texels.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      tileSize: 512,
      zoomOffset: -1,
      minZoom: 2,
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map)

    const updateHud = () => {
      const c = map.getCenter()
      const zoom = map.getZoom()
      const { x, z } = toBlocks(c.lat, c.lng)
      setHud({
        x,
        z,
        y: 64 + (19 - zoom) * 16, // pretend altitude: higher when zoomed out
        biome: biomeFor(c.lat, zoom),
        zoom,
      })
    }
    map.on('move zoom', updateHud)
    updateHud()
  }, [])

  const dropMarker = (lat, lng, icon, popup) => {
    const map = mapRef.current
    if (markerRef.current) markerRef.current.remove()
    markerRef.current = L.marker([lat, lng], { icon }).addTo(map)
    if (popup) markerRef.current.bindPopup(popup).openPopup()
  }

  const search = async (e) => {
    e.preventDefault()
    if (!query.trim()) return
    setStatus('Generating chunks…')
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`
      )
      const data = await res.json()
      if (!data.length) {
        setStatus('Structure not found')
        return
      }
      const { lat, lon, display_name } = data[0]
      mapRef.current.flyTo([+lat, +lon], 15, { duration: 1.2 })
      dropMarker(+lat, +lon, pinIcon, display_name.split(',')[0])
      setStatus('')
    } catch {
      setStatus('Connection lost to server')
    }
  }

  const locate = () => {
    setStatus('Locating player…')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        mapRef.current.flyTo([latitude, longitude], 16, { duration: 1.2 })
        dropMarker(latitude, longitude, playerIcon, 'You (Steve)')
        setStatus('')
      },
      () => setStatus('Player not found — allow location access')
    )
  }

  const zoomBy = (d) => mapRef.current.setZoom(mapRef.current.getZoom() + d)

  return (
    <div className={`world ${night ? 'night' : ''}`}>
      <div ref={mapEl} className="map" />

      {/* Title plaque + search "chat bar" */}
      <div className="panel top-left">
        <h1 className="logo">EnderMaps</h1>
        <form className="chatbar" onSubmit={search}>
          <span className="chat-caret">&gt;</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="/locate city, street, place…"
            aria-label="Search for a place"
          />
          <button className="mc-btn" type="submit">Go</button>
        </form>
        {status && <div className="status">{status}</div>}
      </div>

      {/* F3-style debug HUD */}
      <div className="panel hud top-right" aria-live="polite">
        <div>XYZ: {hud.x} / {hud.y} / {hud.z}</div>
        <div>Chunk: {Math.floor(hud.x / 16)} {Math.floor(hud.z / 16)}</div>
        <div>Biome: {hud.biome}</div>
        <div>Render distance: {hud.zoom}</div>
      </div>

      {/* Hotbar controls */}
      <div className="hotbar">
        <button className="mc-btn slot" onClick={() => zoomBy(1)} aria-label="Zoom in">+</button>
        <button className="mc-btn slot" onClick={() => zoomBy(-1)} aria-label="Zoom out">−</button>
        <button className="mc-btn slot wide" onClick={locate}>◈ Locate me</button>
        <button className="mc-btn slot wide" onClick={() => setNight(!night)}>
          {night ? '☀ Day' : '☾ Night'}
        </button>
      </div>
    </div>
  )
}
