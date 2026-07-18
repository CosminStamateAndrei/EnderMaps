import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'

// ---- Overworld math -------------------------------------------------------
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

// Meters between two lat/lng points (haversine)
const distMeters = (a, b) => {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Decode a Google-encoded polyline. Tries precision 5, falls back to 7.
function decodePolyline(str, precision = 5) {
  let index = 0, lat = 0, lng = 0
  const coords = []
  const factor = 10 ** precision
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0, shift = 0, byte
      do {
        byte = str.charCodeAt(index++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      const delta = result & 1 ? ~(result >> 1) : result >> 1
      if (which === 0) lat += delta
      else lng += delta
    }
    coords.push([lat / factor, lng / factor])
  }
  return coords
}
const decodeNear = (str, refLat) => {
  const p5 = decodePolyline(str, 5)
  if (p5.length && Math.abs(p5[0][0] - refLat) < 1) return p5
  return decodePolyline(str, 7)
}

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)
const fmtTime = (s) => {
  const min = Math.round(s / 60)
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`
}

// Turn an OSRM maneuver into banner text + a pixel-arrow glyph
const ARROWS = {
  left: '⬅', right: '➡', 'slight left': '↖', 'slight right': '↗',
  'sharp left': '↙', 'sharp right': '↘', straight: '⬆', uturn: '↶',
}
const maneuverText = (step) => {
  const { type, modifier } = step.maneuver
  const name = step.name ? ` onto ${step.name}` : ''
  if (type === 'arrive') return { icon: '⚑', text: 'You have arrived' }
  if (type === 'depart') return { icon: '⬆', text: `Head ${modifier || 'out'}${name}` }
  if (type === 'roundabout' || type === 'rotary')
    return { icon: '↻', text: `Take the roundabout${name}` }
  if (type === 'new name' || type === 'continue')
    return { icon: ARROWS[modifier] || '⬆', text: modifier && modifier !== 'straight' ? `Keep ${modifier}${name}` : `Continue straight${name}` }
  return { icon: ARROWS[modifier] || '⬆', text: `Turn ${modifier || ''}${name}`.replace('  ', ' ') }
}

// ---- Pixel icons (inline SVG, no game assets) -----------------------------
const playerIcon = L.divIcon({
  className: 'pixel-marker',
  html: `<svg width="28" height="28" viewBox="0 0 14 14" style="image-rendering:pixelated">
    <path d="M7 0 L13 13 L7 10 L1 13 Z" fill="#ffffff" stroke="#3a3a3a" stroke-width="1"/>
  </svg>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
})
const destIcon = L.divIcon({
  className: 'pixel-marker',
  html: `<svg width="26" height="26" viewBox="0 0 13 13" style="image-rendering:pixelated">
    <rect x="5" y="1" width="3" height="8" fill="#a35ce8"/>
    <rect x="4" y="0" width="5" height="3" fill="#c98cff"/>
    <rect x="5" y="9" width="3" height="3" fill="#5a3d1e"/>
  </svg>`,
  iconSize: [26, 26],
  iconAnchor: [13, 24],
})

const MODES = {
  drive: { label: '🛒 Drive', color: '#3b82f6' },
  cycle: { label: '🚲 Cycle', color: '#6aab4a' },
  transit: { label: '🚌 Transit', color: '#a35ce8' },
}

export default function App() {
  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const layersRef = useRef({})
  const playerRef = useRef(null)
  const accuracyRef = useRef(null)
  const destRef = useRef(null)
  const routeRef = useRef(L.layerGroup())
  const posRef = useRef(null)
  const destPosRef = useRef(null)
  const watchRef = useRef(null)
  const stepsRef = useRef([])   // OSRM steps for the active drive/cycle route
  const stepIdxRef = useRef(0)  // next maneuver we're heading towards
  const navRef = useRef(false)  // live-navigation mode on/off

  const [hud, setHud] = useState({ x: 0, y: 64, z: 0, biome: 'Plains', zoom: 13 })
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('Tip: tap the map to set a destination')
  const [night, setNight] = useState(false)
  const [blocky, setBlocky] = useState(false)
  const [hasDest, setHasDest] = useState(false)
  const [route, setRoute] = useState(null)
  const [nav, setNav] = useState(null) // { icon, text, dist, remaining }

  // ---- Map setup ----------------------------------------------------------
  useEffect(() => {
    if (mapRef.current) return
    const map = L.map(mapEl.current, {
      center: [44.18, 28.65],
      zoom: 13,
      zoomControl: false,
      worldCopyJump: true,
    })
    mapRef.current = map
    routeRef.current.addTo(map)

    const attribution =
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    layersRef.current.fancy = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      minZoom: 2, maxZoom: 19, detectRetina: true, attribution,
    })
    layersRef.current.blocky = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      tileSize: 512, zoomOffset: -1, minZoom: 2, maxZoom: 19, attribution,
      className: 'blocky-tiles',
    })
    layersRef.current.fancy.addTo(map)

    const updateHud = () => {
      const c = map.getCenter()
      const zoom = map.getZoom()
      const { x, z } = toBlocks(c.lat, c.lng)
      setHud({ x, z, y: 64 + (19 - zoom) * 16, biome: biomeFor(c.lat, zoom), zoom })
    }
    map.on('move zoom', updateHud)
    updateHud()

    map.on('click', (e) => {
      if (navRef.current) return // don't retarget mid-navigation by accident
      setDestination(e.latlng.lat, e.latlng.lng, 'Waypoint')
    })
    return () => watchRef.current && navigator.geolocation.clearWatch(watchRef.current)
  }, [])

  // ---- Graphics toggle ----------------------------------------------------
  const toggleGraphics = () => {
    const map = mapRef.current
    const next = !blocky
    map.removeLayer(next ? layersRef.current.fancy : layersRef.current.blocky)
    map.addLayer(next ? layersRef.current.blocky : layersRef.current.fancy)
    setBlocky(next)
  }

  // ---- Turn-by-turn: called on every GPS fix while navigating -------------
  const updateNav = (pos) => {
    const steps = stepsRef.current
    if (!steps.length) return
    let i = stepIdxRef.current
    let d = distMeters(pos, steps[i].loc)
    // Passed the maneuver? Advance (loop in case GPS jumped past several)
    while (i < steps.length - 1 && d < 25) {
      i += 1
      d = distMeters(pos, steps[i].loc)
    }
    stepIdxRef.current = i
    const remaining = d + steps.slice(i).reduce((s, st) => s + st.after, 0)
    const { icon, text } = steps[i].banner
    if (steps[i].isArrive && d < 30) {
      setNav({ icon, text, dist: '', remaining: '' })
      stopNav(false)
      setStatus('⚑ Destination reached!')
    } else {
      setNav({ icon, text, dist: `In ${fmtDist(d)}`, remaining: fmtDist(remaining) })
    }
  }

  // ---- Player location (high accuracy, live) ------------------------------
  const locate = (follow = false) => {
    if (!navigator.geolocation) return setStatus('This browser has no location support')
    setStatus('Locating player…')
    if (watchRef.current) navigator.geolocation.clearWatch(watchRef.current)
    let first = true
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy, heading } = pos.coords
        posRef.current = { lat, lng }
        if (!playerRef.current) {
          playerRef.current = L.marker([lat, lng], { icon: playerIcon }).addTo(mapRef.current)
          accuracyRef.current = L.circle([lat, lng], {
            radius: accuracy, color: '#ffffff', weight: 1, fillColor: '#ffffff', fillOpacity: 0.12,
          }).addTo(mapRef.current)
        } else {
          playerRef.current.setLatLng([lat, lng])
          accuracyRef.current.setLatLng([lat, lng]).setRadius(accuracy)
        }
        // Rotate the arrow to your direction of travel when the device reports it
        const svg = playerRef.current.getElement()?.querySelector('svg')
        if (svg && heading != null && !Number.isNaN(heading))
          svg.style.transform = `rotate(${heading}deg)`

        if (navRef.current) {
          mapRef.current.setView([lat, lng], Math.max(mapRef.current.getZoom(), 17), { animate: true })
          updateNav({ lat, lng })
        } else if (first) {
          mapRef.current.flyTo([lat, lng], 16, { duration: 1.2 })
          setStatus(
            accuracy > 300
              ? `Position ±${Math.round(accuracy)} m — desktop browsers guess from your network; a phone with GPS is far more accurate`
              : `Position ±${Math.round(accuracy)} m`
          )
        }
        first = false
      },
      (err) => setStatus(err.code === 1 ? 'Location blocked — allow it in your browser' : 'Player not found'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    )
  }

  // ---- Navigation on/off --------------------------------------------------
  const startNav = () => {
    if (!stepsRef.current.length) return
    navRef.current = true
    stepIdxRef.current = 0
    setStatus('')
    locate(true)
    if (posRef.current) updateNav(posRef.current)
    else setNav({ icon: '⬆', text: 'Waiting for GPS…', dist: '', remaining: '' })
  }
  const stopNav = (clearBanner = true) => {
    navRef.current = false
    if (clearBanner) setNav(null)
  }

  // ---- Destination + search ----------------------------------------------
  const setDestination = (lat, lng, label) => {
    destPosRef.current = { lat, lng }
    setHasDest(true)
    if (destRef.current) destRef.current.remove()
    destRef.current = L.marker([lat, lng], { icon: destIcon })
      .addTo(mapRef.current)
      .bindPopup(label)
    setStatus('Destination set — pick a travel mode')
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
      if (!data.length) return setStatus('Structure not found')
      const { lat, lon, display_name } = data[0]
      mapRef.current.flyTo([+lat, +lon], 15, { duration: 1.2 })
      setDestination(+lat, +lon, display_name.split(',')[0])
    } catch {
      setStatus('Connection lost to server')
    }
  }

  // ---- Routing ------------------------------------------------------------
  const clearRoute = () => {
    routeRef.current.clearLayers()
    stepsRef.current = []
    stopNav()
    setRoute(null)
  }

  const drawLine = (coords, color, dashed = false) =>
    L.polyline(coords, {
      color, weight: 6, opacity: 0.9, dashArray: dashed ? '2 10' : null, lineCap: 'square',
    }).addTo(routeRef.current)

  const getRoute = async (mode) => {
    if (!destPosRef.current) return setStatus('Tap the map or search to set a destination first')
    if (!posRef.current) {
      setStatus('Finding your position first — tap the mode again once located')
      return locate()
    }
    const a = posRef.current, b = destPosRef.current
    clearRoute()
    setStatus('Calculating path…')
    try {
      if (mode === 'transit') {
        const url =
          `https://api.transitous.org/api/v1/plan?fromPlace=${a.lat},${a.lng}` +
          `&toPlace=${b.lat},${b.lng}&numItineraries=1`
        const res = await fetch(url)
        const data = await res.json()
        const it = data?.itineraries?.[0]
        if (!it) return setStatus('No transit route found here')
        const legs = it.legs.map((leg) => {
          const pts = leg.legGeometry?.points
            ? decodeNear(leg.legGeometry.points, leg.from.lat)
            : [[leg.from.lat, leg.from.lon], [leg.to.lat, leg.to.lon]]
          drawLine(pts, leg.mode === 'WALK' ? '#cccccc' : MODES.transit.color, leg.mode === 'WALK')
          return {
            mode: leg.mode,
            name: leg.routeShortName || '',
            from: leg.from.name === 'START' ? 'Start' : leg.from.name,
          }
        })
        const dur = (new Date(it.endTime) - new Date(it.startTime)) / 1000 || it.duration
        setRoute({ mode, time: fmtTime(dur), dist: null, legs })
      } else {
        const profile = mode === 'drive' ? 'routed-car' : 'routed-bike'
        const url =
          `https://routing.openstreetmap.de/${profile}/route/v1/x/` +
          `${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&steps=true`
        const res = await fetch(url)
        const data = await res.json()
        const r = data?.routes?.[0]
        if (!r) return setStatus('No route found')
        drawLine(r.geometry.coordinates.map(([lng, lat]) => [lat, lng]), MODES[mode].color)
        // Store maneuvers for turn-by-turn: where it happens, what to say,
        // and how many meters follow it until the next one.
        stepsRef.current = (r.legs?.[0]?.steps || []).map((s) => ({
          loc: { lat: s.maneuver.location[1], lng: s.maneuver.location[0] },
          banner: maneuverText(s),
          after: s.distance,
          isArrive: s.maneuver.type === 'arrive',
        }))
        setRoute({ mode, dist: fmtDist(r.distance), time: fmtTime(r.duration), legs: null })
      }
      mapRef.current.fitBounds(L.latLngBounds([a, b]).pad(0.25))
      setStatus('')
    } catch {
      setStatus('Pathfinding failed — the free routing server may be busy, try again')
    }
  }

  // ---- UI -----------------------------------------------------------------
  return (
    <div className={`world ${night ? 'night' : ''} ${blocky ? 'is-blocky' : ''}`}>
      <div ref={mapEl} className="map" />

      {/* Turn-by-turn banner, top-center while navigating */}
      {nav && (
        <div className="nav-banner" role="status">
          <span className="nav-icon">{nav.icon}</span>
          <div className="nav-text">
            {nav.dist && <div className="nav-dist">{nav.dist}</div>}
            <div className="nav-instruction">{nav.text}</div>
            {nav.remaining && <div className="nav-remaining">{nav.remaining} to go</div>}
          </div>
          <button className="mc-btn tiny" onClick={() => stopNav()} aria-label="Stop navigation">✕</button>
        </div>
      )}

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

        {hasDest && (
          <div className="mode-row">
            {Object.entries(MODES).map(([key, m]) => (
              <button
                key={key}
                className={`mc-btn mode-btn ${route?.mode === key ? 'active' : ''}`}
                onClick={() => getRoute(key)}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}

        {route && (
          <div className="route-card">
            <div className="route-head">
              <span style={{ color: MODES[route.mode].color }}>
                {route.time}{route.dist ? ` · ${route.dist}` : ''}
              </span>
              <button className="mc-btn tiny" onClick={clearRoute}>✕</button>
            </div>
            {route.legs && (
              <ol className="legs">
                {route.legs.map((leg, i) => (
                  <li key={i}>
                    {leg.mode === 'WALK' ? '🚶 Walk' : `🚌 ${leg.mode} ${leg.name}`}
                    {leg.from ? ` — from ${leg.from}` : ''}
                  </li>
                ))}
              </ol>
            )}
            {route.mode !== 'transit' && !nav && (
              <button className="mc-btn start-btn" onClick={startNav}>▶ START</button>
            )}
          </div>
        )}

        {status && <div className="status">{status}</div>}
      </div>

      <div className="panel hud top-right" aria-live="polite">
        <div>XYZ: {hud.x} / {hud.y} / {hud.z}</div>
        <div>Chunk: {Math.floor(hud.x / 16)} {Math.floor(hud.z / 16)}</div>
        <div>Biome: {hud.biome}</div>
        <div>Render distance: {hud.zoom}</div>
      </div>

      <div className="hotbar">
        <button className="mc-btn slot" onClick={() => mapRef.current.zoomIn()} aria-label="Zoom in">+</button>
        <button className="mc-btn slot" onClick={() => mapRef.current.zoomOut()} aria-label="Zoom out">−</button>
        <button className="mc-btn slot wide" onClick={() => locate()}>◈ Locate me</button>
        <button className="mc-btn slot wide" onClick={toggleGraphics}>
          {blocky ? 'Graphics: Blocky' : 'Graphics: Fancy'}
        </button>
        <button className="mc-btn slot wide" onClick={() => setNight(!night)}>
          {night ? '☀ Day' : '☾ Night'}
        </button>
      </div>
    </div>
  )
}