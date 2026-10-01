/**
 * Geolocation helpers for AvSGo.
 * Wraps navigator.geolocation with promises + gentle timeouts, and
 * provides a permission probe so the UI can render the right state.
 */

const DEFAULT_OPTS = {
  enableHighAccuracy: true,
  timeout: 12000,
  maximumAge: 20000,
};

export function isGeoSupported() {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

const GEO_ERROR_MAP = {
  1: { code: "denied", message: "Location permission denied. Enable it in your browser and try again." },
  2: { code: "unavailable", message: "Location unavailable right now. Please check GPS and try again." },
  3: { code: "timeout", message: "Location request timed out. Please try again." },
};

/** One-shot current position. Rejects with a friendly Error. */
export function getCurrentPosition(opts = {}) {
  return new Promise((resolve, reject) => {
    if (!isGeoSupported()) {
      const e = new Error("Location not supported on this device");
      e.code = "unsupported";
      return reject(e);
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) => {
        const mapped = GEO_ERROR_MAP[err.code] || { code: "error", message: "Could not read your location." };
        const friendly = new Error(mapped.message);
        friendly.code = mapped.code;
        reject(friendly);
      },
      { ...DEFAULT_OPTS, ...opts },
    );
  });
}

/**
 * Continuously watch the position. Returns an unsubscribe function.
 * onUpdate({lat, lng, accuracy}) fires on each update.
 * onError(err) fires on permission/GPS errors.
 */
export function watchPosition(onUpdate, onError) {
  if (!isGeoSupported()) {
    onError?.(Object.assign(new Error("unsupported"), { code: "unsupported" }));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) =>
      onUpdate?.({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
    (err) => onError?.(err),
    { ...DEFAULT_OPTS, maximumAge: 15000 },
  );
  return () => {
    try {
      navigator.geolocation.clearWatch(id);
    } catch (_) {}
  };
}

/**
 * Probe the browser permissions API.
 * Returns: "granted" | "denied" | "prompt" | "unknown"
 */
export async function checkGeoPermission() {
  if (typeof navigator === "undefined" || !navigator.permissions) return "unknown";
  try {
    const p = await navigator.permissions.query({ name: "geolocation" });
    return p.state;
  } catch (_) {
    return "unknown";
  }
}

/** Fast local haversine (metres) — useful for on-device sanity checks. */
export function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
