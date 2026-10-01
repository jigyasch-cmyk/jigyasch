# AvSGo — Product Requirements

## Overview
"AvSGo" is a local vehicle booking platform in Assam covering **E-Rickshaw, Tata Ace, Tempo, and Tractor** goods transport services.

## Delivered Features
- Auth: Driver + Admin (JWT)
- Vehicle CRUD + admin approval + availability toggle
- Broadcast booking with first-accept-wins atomic locking
- GPS nearest-driver matching (2dsphere)
- Commission payments (driver submits UTR → admin approves) + partial application to unpaid bookings
- Web Push (VAPID), In-app Bell (chime + quiet hours)
- PWA branding + SEO
- Real road-distance via OSRM (no key), ORS fallback, HTTP 503 on failure — never faked
- Rapido-style unified booking screen — shared map + blue GPS dot + emerald route polyline
- PIN-code drop-gate with dual-provider lookup (postalpincode.in + Nominatim/Photon cascade + 12h TTL cache)
- **Three-tier drop autocomplete (Feb 2026)**:
  1. **Within PIN**: Photon strict bbox (real OSM POIs)
  2. **Nearest PIN**: Photon widened 1×→3×→6×→12× capped at ~50 km half-extent (so no cross-state leakage)
  3. **Wikipedia knowledge base**: for real institutions OSM hasn't tagged (e.g. Madhabdev University) — semantic-match gate so Wikipedia hits are **prepended** whenever Photon results don't contain the customer's proper-noun token; strict `max_km=60` distance filter
- Compound-query relaxation to longest proper-noun token
- Google-Maps-style fullscreen drop search overlay with first-letter bold highlight
- Draggable red drop pin + tap-to-drop on map with reverse-geocoding

## Providers
- Routing: OSRM public → ORS fallback (`ROUTING_API_KEY`) → HTTP 503
- PIN lookup: api.postalpincode.in (browser UA + retry) + Nominatim/Photon coord cascade
- Pickup Geocoding + reverse geocoding: Nominatim
- Drop Autocomplete: Photon `/api` (bbox widening + longest-token relaxation) + Wikipedia (`en.wikipedia.org/w/api.php`) geosearch for real institutions not in OSM
- Map tiles: OpenStreetMap via Leaflet 1.9.4 CDN

## Roadmap
### P1
- Live driver location on customer wait screen
- Persist PIN cache to Mongo for cross-restart hits
- Admin CSV export for approved commission payments
### P2
- Break server.py into `routes/` modules
- Migrate outbound HTTP to httpx.AsyncClient (parallel calls)
- Pending-booking auto-expiry
- Assamese/Hindi UI toggle
- Trip ratings & round-trip toggle
- "Recent drops" list in the drop-search overlay
- Extend Wikipedia fallback with Wikidata SPARQL for even better POI coverage

## Key Endpoints
- `POST /api/route` — road distance + duration + geometry + fare
- `GET /api/geocode` — Assam-biased or bbox-scoped Nominatim search (pickup)
- `GET /api/places/autocomplete` — Photon + Wikipedia three-tier autocomplete
- `GET /api/reverse-geocode`
- `GET /api/pincode/{pincode}` — dual-provider PIN → area + coords + bbox with 12h caching
- `POST /api/customer/bookings` & `/api/customer/bookings/auto`

## Test Credentials
See `/app/memory/test_credentials.md`
