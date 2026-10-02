import { useEffect, useRef } from "react";
import { loadLeaflet } from "@/lib/leaflet";

/**
 * Small non-interactive map preview showing pickup marker, drop marker
 * and the road route polyline returned by the backend routing service.
 */
export default function RoutePreview({ pickup, drop, geometry }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef([]);

  useEffect(() => {
    if (!containerRef.current || !pickup || !drop) return;
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !containerRef.current) return;

      // (Re)create map on first mount
      if (!mapRef.current) {
        mapRef.current = L.map(containerRef.current, {
          zoomControl: false,
          attributionControl: false,
          dragging: false,
          scrollWheelZoom: false,
          doubleClickZoom: false,
          touchZoom: false,
          boxZoom: false,
          keyboard: false,
        });
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(mapRef.current);
      }
      const map = mapRef.current;

      // Clear previous layers
      layersRef.current.forEach((l) => { try { map.removeLayer(l); } catch (_) {} });
      layersRef.current = [];

      const pickupIcon = L.divIcon({
        className: "",
        html: '<div style="background:#059669;color:#fff;font-size:10px;font-weight:800;padding:2px 6px;border-radius:9999px;box-shadow:0 2px 6px rgba(0,0,0,0.25);border:2px solid #fff">P</div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      const dropIcon = L.divIcon({
        className: "",
        html: '<div style="background:#e11d48;color:#fff;font-size:10px;font-weight:800;padding:2px 6px;border-radius:9999px;box-shadow:0 2px 6px rgba(0,0,0,0.25);border:2px solid #fff">D</div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });

      const pk = L.marker([pickup.lat, pickup.lng], { icon: pickupIcon }).addTo(map);
      const dp = L.marker([drop.lat, drop.lng], { icon: dropIcon }).addTo(map);
      layersRef.current.push(pk, dp);

      let bounds;
      if (geometry && geometry.length > 1) {
        const poly = L.polyline(geometry, { color: "#059669", weight: 4, opacity: 0.85 }).addTo(map);
        layersRef.current.push(poly);
        bounds = poly.getBounds();
      } else {
        bounds = L.latLngBounds([[pickup.lat, pickup.lng], [drop.lat, drop.lng]]);
      }
      map.fitBounds(bounds, { padding: [30, 30] });
      setTimeout(() => map.invalidateSize(), 50);
    });
    return () => { cancelled = true; };
  }, [pickup, drop, geometry]);

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (mapRef.current) {
        try { mapRef.current.remove(); } catch (_) {}
        mapRef.current = null;
      }
    };
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="customer-route-preview"
      className="h-56 w-full rounded-2xl overflow-hidden border border-gray-200 bg-gray-100"
    />
  );
}
