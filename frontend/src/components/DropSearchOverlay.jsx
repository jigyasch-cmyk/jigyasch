

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, X, MapPin, Loader2, Search } from "lucide-react";
import api from "@/lib/api";

function highlight(text, query) {
  if (!text) return text;
  const q = (query || "").trim();
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;

  return <>
    <span>{text.slice(0, i)}</span>
    <b className="font-bold text-gray-900">
      {text.slice(i, i + q.length)}
    </b>
    <span>{text.slice(i + q.length)}</span>
  </>;
}

export default function DropSearchOverlay({ open, onClose, onSelect }) {
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState([]);
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const inputRef = useRef(null);
  const requestRef = useRef(0);
  const pageSize = 50;

  useEffect(() => {
    if (!open) return;

    const t = setTimeout(() => inputRef.current?.focus(), 80);
    return () => {
      clearTimeout(t);
      requestRef.current += 1;
      setQuery("");
      setPlaces([]);
      setOffset(0);
      setHasMore(false);
      setBusy(false);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const requestId = ++requestRef.current;
    setBusy(true);

    const t = setTimeout(async () => {
      try {
        const r = await api.get("/drop-places", {
          params: {
            q: query.trim(),
            limit: pageSize,
            offset: 0
          }
        });

        if (requestId !== requestRef.current) return;

        const data = Array.isArray(r.data) ? r.data : [];
        setPlaces(data);
        setOffset(data.length);
        setHasMore(data.length === pageSize);
      } catch {
        if (requestId === requestRef.current) {
          setPlaces([]);
          setOffset(0);
          setHasMore(false);
        }
      } finally {
        if (requestId === requestRef.current) {
          setBusy(false);
        }
      }
    }, 250);

    return () => clearTimeout(t);
  }, [query, open]);

  async function loadMore() {
    if (busy || !hasMore) return;

    const requestId = ++requestRef.current;
    setBusy(true);

    try {
      const r = await api.get("/drop-places", {
        params: {
          q: query.trim(),
          limit: pageSize,
          offset
        }
      });

      if (requestId !== requestRef.current) return;

      const data = Array.isArray(r.data) ? r.data : [];
      setPlaces(previous => [...previous, ...data]);
      setOffset(previous => previous + data.length);
      setHasMore(data.length === pageSize);
    } catch {
      // Keep already loaded places if loading the next page fails.
    } finally {
      if (requestId === requestRef.current) {
        setBusy(false);
      }
    }
  }

  if (!open) return null;

  const q = query.trim();

  return (
    <div
      className="fixed inset-0 z-[70] bg-white flex flex-col"
      data-testid="drop-search-overlay"
    >
      <div className="px-3 pt-4 pb-3 border-b border-gray-100">
        <div className="flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1.5">
          <button
            data-testid="drop-search-close"
            onClick={onClose}
            className="h-9 w-9 rounded-full flex items-center justify-center"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <input
            ref={inputRef}
            data-testid="drop-search-input"
            className="flex-1 bg-transparent outline-none text-base py-1"
            placeholder="Search AvSGo Drop Place"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoComplete="off"
          />

          {busy ? (
            <Loader2 className="h-5 w-5 text-emerald-600 animate-spin mr-2" />
          ) : q ? (
            <button
              data-testid="drop-search-clear"
              onClick={() => setQuery("")}
              className="h-9 w-9 flex items-center justify-center"
            >
              <div className="h-6 w-6 rounded-full bg-gray-400 flex items-center justify-center">
                <X className="h-3.5 w-3.5 text-white" />
              </div>
            </button>
          ) : (
            <Search className="h-5 w-5 text-gray-400 mr-2" />
          )}
        </div>

        <div className="text-[11px] text-gray-500 mt-2 px-2">
          Only places added and enabled by Admin or authorized Manager are shown.
        </div>
      </div>

      <div className="flex-1 overflow-auto pb-6">
        {!q && !places.length && !busy && (
          <div className="p-5 text-sm text-gray-500">
            No enabled AvSGo Drop Places found.
          </div>
        )}

        {places.map((p, i) => (
          <button
            key={p.id}
            data-testid={`drop-search-result-${i}`}
            onClick={() => onSelect({
              id: p.id,
              lat: Number(p.latitude),
              lng: Number(p.longitude),
              display_name: p.place_name,
              place_name: p.place_name
            })}
            className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 text-left border-b border-gray-100"
          >
            <div className="h-10 w-10 rounded-full bg-emerald-50 flex items-center justify-center shrink-0">
              <MapPin className="h-5 w-5 text-emerald-600" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[15px] text-gray-800 truncate">
                {highlight(p.place_name, q)}
              </div>
              <div className="text-xs text-gray-400 mt-0.5">
                AvSGo common drop place
              </div>
            </div>
          </button>
        ))}

        {q && !places.length && !busy && (
          <div className="p-6 text-center text-sm text-gray-500">
            No enabled AvSGo Drop Place found for “{query}”.
          </div>
        )}

        {hasMore && (
          <div className="p-4 text-center">
            <button
              onClick={loadMore}
              disabled={busy}
              className="rounded-full bg-emerald-600 text-white px-6 py-2 text-sm disabled:opacity-50"
            >
              {busy ? "Loading..." : "Load More Places"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
