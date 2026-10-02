// Lazy-loads Leaflet from CDN once and returns window.L.
const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";

let promise = null;

export function loadLeaflet() {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.L) return Promise.resolve(window.L);
  if (promise) return promise;
  promise = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      link.crossOrigin = "";
      document.head.appendChild(link);
    }
    const existing = document.querySelector(`script[src="${LEAFLET_JS}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.L));
      existing.addEventListener("error", reject);
      return;
    }
    const s = document.createElement("script");
    s.src = LEAFLET_JS;
    s.async = true;
    s.crossOrigin = "";
    s.onload = () => resolve(window.L);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return promise;
}
