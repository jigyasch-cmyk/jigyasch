import { useEffect, useRef, useState } from "react";
import { X, Search, MapPin, Loader2, Locate, Check } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";
import { loadLeaflet } from "@/lib/leaflet";
import { getCurrentPosition, isGeoSupported } from "@/lib/geo";

// Guwahati (Assam) as sane default centre when no GPS/init is available.
const DEFAULT_CENTER = { lat: 26.1445, lng: 91.7362 };

export default function MapPicker({ open, title, initial, onClose, onConfirm, testidPrefix = "map-picker" }) {
  const mapRef = useRef(null);
  const containerRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [center, setCenter] = useState(initial || DEFAULT_CENTER);
  const [address, setAddress] = useState("");
  const [addressLoading, setAddressLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [locBusy, setLocBusy] = useState(false);

  // Init map when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let map;
    loadLeaflet()
      .then((L) => {
        if (cancelled || !containerRef.current) return;
        const start = initial || DEFAULT_CENTER;
        map = L.map(containerRef.current, { zoomControl: false, attributionControl: false })
          .setView([start.lat, start.lng], 15);
        L.control.zoom({ position: "bottomright" }).addTo(map);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
        }).addTo(map);
        map.on("moveend", () => {
          const c = map.getCenter();
          setCenter({ lat: c.lat, lng: c.lng });
        });
        mapRef.current = map;
        setCenter({ lat: start.lat, lng: start.lng });
        setReady(true);
        setTimeout(() => map.invalidateSize(), 100);
      })
      .catch(() => toast.error("Map could not load. Check your internet."));
    return () => {
      cancelled = true;
      setReady(false);
      if (mapRef.current) {
        try { mapRef.current.remove(); } catch (_) {}
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reverse geocode current center (debounced)
  useEffect(() => {
    if (!open || !ready) return;
    setAddressLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.get(`/reverse-geocode?lat=${center.lat}&lng=${center.lng}`);
        setAddress(r.data?.display_name || "");
      } catch (_) {
        setAddress("");
      } finally {
        setAddressLoading(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [center.lat, center.lng, open, ready]);

  // Search suggestions (debounced)
  useEffect(() => {
    if (!query || query.trim().length < 3) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const r = await api.get(`/geocode?q=${encodeURIComponent(query.trim())}`);
        setResults(r.data?.results || []);
      } catch (_) {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const flyTo = (lat, lng, zoom = 16) => {
    if (mapRef.current) mapRef.current.setView([lat, lng], zoom);
    setCenter({ lat, lng });
    setResults([]);
    setQuery("");
  };

  const useMyLocation = async () => {
    if (!isGeoSupported()) return toast.error("Location not supported");
    setLocBusy(true);
    try {
      const c = await getCurrentPosition();
      flyTo(c.lat, c.lng, 17);
    } catch (e) {
      toast.error(e.message || "Could not read your location");
    } finally {
      setLocBusy(false);
    }
  };

  const confirm = () => {
    if (!center?.lat || !center?.lng) return;
    onConfirm({
      lat: center.lat,
      lng: center.lng,
      display_name: address || `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`,
    });
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] bg-white flex flex-col" data-testid={testidPrefix}>
      <div className="p-3 border-b border-gray-200 flex items-center gap-2">
        <button
          data-testid={`${testidPrefix}-close`}
          onClick={onClose}
          className="h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center"
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="font-display font-bold text-base flex-1 truncate">{title || "Select location"}</div>
      </div>

      <div className="p-3 border-b border-gray-200 relative">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            data-testid={`${testidPrefix}-search`}
            className="field pl-10"
            placeholder="Search area, landmark, city…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            inputMode="search"
            autoComplete="off"
          />
        </div>
        {results.length > 0 && (
          <div className="absolute left-3 right-3 top-[68px] bg-white border border-gray-200 rounded-xl shadow-lg max-h-64 overflow-auto z-10">
            {results.map((r, i) => (
              <button
                key={`${r.lat}-${r.lng}-${i}`}
                data-testid={`${testidPrefix}-result-${i}`}
                onClick={() => flyTo(r.lat, r.lng)}
                className="w-full text-left p-3 hover:bg-emerald-50 border-b last:border-b-0 text-sm"
              >
                <div className="font-semibold text-gray-800 line-clamp-2">{r.display_name}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 relative bg-gray-100">
        <div ref={containerRef} className="absolute inset-0" data-testid={`${testidPrefix}-canvas`} />
        {/* Centre crosshair pin (Rapido-style) */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full">
          <div className="relative">
            <MapPin className="h-11 w-11 text-emerald-600 drop-shadow-md" strokeWidth={2.5} fill="#10b981" fillOpacity={0.15} />
            <div className="absolute left-1/2 top-full -translate-x-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-emerald-700 border-2 border-white shadow" />
          </div>
        </div>
        {isGeoSupported() && (
          <button
            data-testid={`${testidPrefix}-locate`}
            onClick={useMyLocation}
            disabled={locBusy}
            className="absolute right-4 bottom-6 h-11 w-11 rounded-full bg-white shadow-md flex items-center justify-center border border-gray-200 disabled:opacity-60"
            aria-label="Use my location"
          >
            <Locate className={`h-5 w-5 text-emerald-700 ${locBusy ? "animate-pulse" : ""}`} />
          </button>
        )}
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-500 gap-2">
            <Loader2 className="h-5 w-5 animate-spin" /> Loading map…
          </div>
        )}
      </div>

      <div className="p-4 border-t border-gray-200 bg-white space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold">Selected address</div>
        <div className="text-sm font-semibold text-gray-800 min-h-[2.5rem] flex items-start gap-2" data-testid={`${testidPrefix}-address`}>
          {addressLoading ? (
            <><Loader2 className="h-4 w-4 animate-spin mt-0.5" /> Fetching address…</>
          ) : (
            <span className="line-clamp-2">{address || "Move the map to select a precise location"}</span>
          )}
        </div>
        <button
          data-testid={`${testidPrefix}-confirm`}
          disabled={!ready || !address}
          onClick={confirm}
          className="brand-btn w-full disabled:opacity-60"
        >
          <Check className="h-5 w-5 mr-2" /> Confirm location
        </button>
      </div>
    </div>
  );
}
