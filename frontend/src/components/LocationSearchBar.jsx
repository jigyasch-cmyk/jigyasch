import { useEffect, useRef, useState } from "react";
import { Loader2, X, Search } from "lucide-react";
import api from "@/lib/api";

/**
 * Rapido-style debounced location search bar.
 * Passes an optional bounding-box + `bounded` flag to /api/geocode so results
 * can be strictly scoped to the customer-entered PIN area.
 */
export default function LocationSearchBar({
  label,
  icon,
  value,
  onSelect,
  onClear,
  placeholder,
  testid,
  bbox,          // { south, north, west, east } — optional
  bounded = 0,   // 0 = soft bias, 1 = strict
  disabled = false,
  disabledHint,
  minChars = 1,
  autocomplete = false, // true → use /api/places/autocomplete (Photon, prefix-aware)
  bias,          // { lat, lng } — extra centre bias for autocomplete
  debounceMs = 250,
}) {
  const [text, setText] = useState(value?.display_name || "");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  const blurTimer = useRef(null);
  const lastAcceptedRef = useRef(value?.display_name || "");

  useEffect(() => {
    setText(value?.display_name || "");
    lastAcceptedRef.current = value?.display_name || "";
  }, [value?.display_name]);

  useEffect(() => {
    const q = (text || "").trim();
    if (!q || q.length < minChars || q === lastAcceptedRef.current) {
      setResults([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q, limit: "10" });
        if (bbox && bbox.south != null) {
          params.set("west", String(bbox.west));
          params.set("south", String(bbox.south));
          params.set("east", String(bbox.east));
          params.set("north", String(bbox.north));
        }
        let url;
        if (autocomplete) {
          if (bias && bias.lat != null && bias.lng != null) {
            params.set("lat", String(bias.lat));
            params.set("lng", String(bias.lng));
          }
          url = `/places/autocomplete?${params.toString()}`;
        } else {
          params.set("bounded", String(bounded ? 1 : 0));
          url = `/geocode?${params.toString()}`;
        }
        const r = await api.get(url);
        setResults(r.data?.results || []);
      } catch (_) {
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, debounceMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, bbox?.south, bbox?.north, bbox?.west, bbox?.east, bounded, autocomplete, bias?.lat, bias?.lng, debounceMs]);

  const pick = (r) => {
    lastAcceptedRef.current = r.display_name;
    setText(r.display_name);
    setOpen(false);
    setResults([]);
    onSelect({ lat: r.lat, lng: r.lng, display_name: r.display_name });
  };

  const clear = () => {
    setText("");
    setResults([]);
    setOpen(false);
    lastAcceptedRef.current = "";
    onClear && onClear();
    inputRef.current && inputRef.current.focus();
  };

  return (
    <div className="relative">
      <div
        className={
          "flex items-center gap-3 rounded-xl border bg-white px-3 py-2.5 transition " +
          (disabled ? "border-gray-200 opacity-60 pointer-events-none" : "border-gray-200 focus-within:border-emerald-500")
        }
      >
        <div className="shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">{label}</div>
          <input
            ref={inputRef}
            data-testid={testid}
            className="w-full bg-transparent outline-none text-sm font-semibold text-gray-800 placeholder-gray-400 disabled:cursor-not-allowed"
            value={text}
            placeholder={disabled && disabledHint ? disabledHint : (placeholder || "Search area, landmark, village…")}
            onChange={(e) => { setText(e.target.value); setOpen(true); }}
            onFocus={() => { clearTimeout(blurTimer.current); if (text) setOpen(true); }}
            onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 180); }}
            inputMode="search"
            autoComplete="off"
            disabled={disabled}
          />
        </div>
        {busy ? (
          <Loader2 className="h-4 w-4 text-emerald-600 animate-spin shrink-0" />
        ) : text ? (
          <button
            data-testid={`${testid}-clear`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={clear}
            className="h-6 w-6 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center shrink-0"
            aria-label="Clear"
          >
            <X className="h-3.5 w-3.5 text-gray-600" />
          </button>
        ) : (
          <Search className="h-4 w-4 text-gray-400 shrink-0" />
        )}
      </div>
      {open && !disabled && !busy && text.trim().length >= minChars && results.length === 0 && text !== lastAcceptedRef.current && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-40 p-3 text-xs text-gray-600" data-testid={`${testid}-empty`}>
          No matching places found{bbox ? " in this area" : ""}. Try a different keyword.
        </div>
      )}
      {open && !disabled && results.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-40 max-h-72 overflow-auto">
          {results.map((r, i) => (
            <button
              key={`${r.lat}-${r.lng}-${i}`}
              data-testid={`${testid}-result-${i}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
              className="w-full text-left p-3 hover:bg-emerald-50 border-b border-gray-100 last:border-b-0"
            >
              <div className="text-sm font-semibold text-gray-800 line-clamp-2">{r.display_name}</div>
              {(r.category || r.type) && (
                <div className="mt-1">
                  <span className="inline-block text-[10px] font-semibold text-emerald-800 bg-emerald-100 rounded-full px-2 py-0.5 capitalize">
                    {[r.category, r.type].filter(Boolean).join(" • ").replace(/_/g, " ")}
                  </span>
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
