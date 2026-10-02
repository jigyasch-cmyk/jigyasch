import { useEffect, useRef } from "react";
import { loadLeaflet } from "@/lib/leaflet";

/**
 * Interactive Rapido-style booking map with:
 *   - OSM tiles
 *   - PIN-area rectangle overlay (amber dashed) when pinArea is provided
 *   - Route polyline (emerald)
 *   - Green pickup marker
 *   - Red drop marker — DRAGGABLE; fires onDropChange({lat,lng}) on drag-end
 *   - Blue pulsing GPS dot for the customer's current location
 *   - Click on empty map places / moves the drop pin (only when pinArea is set)
 *   - Auto-fits bounds on updates
 *   - `recenterKey` prop increments to force fly-to user location
 */
export default function BookingMap({
  pickup,
  drop,
  geometry,
  userLocation,
  pinArea,
  recenterKey = 0,
  onDropChange,
  height = "h-72",
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef({ pk: null, dp: null, poly: null, me: null, pin: null });
  const onDropChangeRef = useRef(onDropChange);
  const pinAreaRef = useRef(pinArea);
  useEffect(() => { onDropChangeRef.current = onDropChange; }, [onDropChange]);
  useEffect(() => { pinAreaRef.current = pinArea; }, [pinArea]);

  // Init map once
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return;
      const start = userLocation || pickup || drop || { lat: 26.1445, lng: 91.7362 };
      const map = L.map(containerRef.current, { zoomControl: false, attributionControl: false })
        .setView([start.lat, start.lng], 14);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);

      // Click-to-place: only active when a PIN area is set (drop selection allowed).
      map.on("click", (e) => {
        if (!onDropChangeRef.current) return;
        onDropChangeRef.current({ lat: e.latlng.lat, lng: e.latlng.lng, source: "map-click" });
      });

      mapRef.current = map;
      setTimeout(() => map.invalidateSize(), 80);
    });
    return () => {
      cancelled = true;
      if (mapRef.current) { try { mapRef.current.remove(); } catch (_) {} mapRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update layers + fit bounds
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    const L = window.L;
    const map = mapRef.current;
    const layers = layersRef.current;

    // PIN-area rectangle (disabled in FINAL flow)
    if (layers.pin) { map.removeLayer(layers.pin); layers.pin = null; }
    if (pinArea && pinArea.bbox) {
      const { south, north, west, east } = pinArea.bbox;
      layers.pin = L.rectangle(
        [[south, west], [north, east]],
        { color: "#f59e0b", weight: 2, dashArray: "6 4", fillColor: "#f59e0b", fillOpacity: 0.06, interactive: false },
      ).addTo(map);
    }

    // Pickup (green pin, not draggable)
    if (pickup) {
      const icon = L.divIcon({
        className: "",
        html: '<div style="width:34px;height:44px"><svg viewBox="0 0 32 40" width="34" height="44" style="filter:drop-shadow(0 3px 4px rgba(0,0,0,.35))"><path fill="#059669" stroke="#fff" stroke-width="2" d="M16 1c-8 0-14 6-14 14 0 10 14 24 14 24s14-14 14-24c0-8-6-14-14-14z"/><circle cx="16" cy="15" r="5" fill="#fff"/></svg></div>',
        iconSize: [34, 44],
        iconAnchor: [17, 42],
      });
      if (!layers.pk) layers.pk = L.marker([pickup.lat, pickup.lng], { icon }).addTo(map);
      else layers.pk.setLatLng([pickup.lat, pickup.lng]);
    } else if (layers.pk) { map.removeLayer(layers.pk); layers.pk = null; }

    // Drop (red pin, DRAGGABLE)
    if (drop) {
      const icon = L.divIcon({
        className: "",
        html: '<div style="width:34px;height:44px"><svg viewBox="0 0 32 40" width="34" height="44" style="filter:drop-shadow(0 3px 4px rgba(0,0,0,.35))"><path fill="#e11d48" stroke="#fff" stroke-width="2" d="M16 1c-8 0-14 6-14 14 0 10 14 24 14 24s14-14 14-24c0-8-6-14-14-14z"/><circle cx="16" cy="15" r="5" fill="#fff"/></svg></div>',
        iconSize: [34, 44],
        iconAnchor: [17, 42],
      });
      if (!layers.dp) {
        layers.dp = L.marker([drop.lat, drop.lng], { icon, draggable: true, autoPan: true }).addTo(map);
        layers.dp.on("dragend", () => {
          const p = layers.dp.getLatLng();
          if (onDropChangeRef.current) onDropChangeRef.current({ lat: p.lat, lng: p.lng, source: "drag" });
        });
      } else {
        layers.dp.setLatLng([drop.lat, drop.lng]);
        layers.dp.setIcon(icon);
        layers.dp.dragging && layers.dp.dragging.enable();
      }
    } else if (layers.dp) { map.removeLayer(layers.dp); layers.dp = null; }

    // Route polyline
    if (layers.poly) { map.removeLayer(layers.poly); layers.poly = null; }
    if (geometry && geometry.length > 1) {
      layers.poly = L.polyline(geometry, { color: "#059669", weight: 5, opacity: 0.85 }).addTo(map);
    }

    // User blue dot (pulsing)
    if (userLocation) {
      const html = `
        <div style="position:relative;width:18px;height:18px">
          <div style="position:absolute;inset:-8px;border-radius:9999px;background:#3b82f6;opacity:.20;animation:avspulse 2s ease-out infinite"></div>
          <div style="width:18px;height:18px;border-radius:9999px;background:#3b82f6;border:3px solid #fff;box-shadow:0 2px 4px rgba(0,0,0,.35)"></div>
        </div>`;
      const icon = L.divIcon({ className: "", html, iconSize: [18, 18], iconAnchor: [9, 9] });
      if (!layers.me) layers.me = L.marker([userLocation.lat, userLocation.lng], { icon, interactive: false, keyboard: false }).addTo(map);
      else layers.me.setLatLng([userLocation.lat, userLocation.lng]).setIcon(icon);
    } else if (layers.me) { map.removeLayer(layers.me); layers.me = null; }

    // Auto-fit
    const pts = [];
    if (pickup) pts.push([pickup.lat, pickup.lng]);
    if (drop) pts.push([drop.lat, drop.lng]);
    if (pinArea && pinArea.bbox) {
      pts.push([pinArea.bbox.south, pinArea.bbox.west]);
      pts.push([pinArea.bbox.north, pinArea.bbox.east]);
    }
    if (!pts.length && userLocation) pts.push([userLocation.lat, userLocation.lng]);
    if (pts.length === 1) {
      map.setView(pts[0], 15, { animate: true });
    } else if (pts.length >= 2) {
      const b = L.latLngBounds(pts);
      if (geometry && geometry.length > 1) b.extend(geometry);
      map.fitBounds(b, { padding: [40, 40], maxZoom: 16 });
    }
    setTimeout(() => map.invalidateSize(), 60);
  }, [pickup, drop, geometry, userLocation, pinArea]);

  // Recenter on demand
  useEffect(() => {
    if (!recenterKey || !mapRef.current || !userLocation) return;
    mapRef.current.flyTo([userLocation.lat, userLocation.lng], 16, { duration: 0.7 });
  }, [recenterKey, userLocation]);

  return (
    <div className={`relative w-full ${height} rounded-2xl overflow-hidden border border-gray-200 bg-gray-100`}>
      <style>{`@keyframes avspulse { 0% { transform:scale(.6); opacity:.6 } 100% { transform:scale(1.6); opacity:0 } }`}</style>
      <div ref={containerRef} className="absolute inset-0" data-testid="booking-map" />
    </div>
  );
}
