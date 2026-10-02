/**
 * Geolocation helpers for AvSGo.
 * Browser/PWA and Capacitor Android compatible.
 */
const DEFAULT_OPTS = {
  enableHighAccuracy: true,
  timeout: 12000,
  maximumAge: 20000,
};

let CapacitorGeolocation = null;
async function getNativeGeo() {
  try {
    if (typeof window === "undefined" || !window.Capacitor?.isNativePlatform?.()) return null;
    if (!CapacitorGeolocation) {
      const mod = await import("@capacitor/geolocation");
      CapacitorGeolocation = mod.Geolocation;
    }
    return CapacitorGeolocation;
  } catch (_) {
    return null;
  }
}

export function isGeoSupported() {
  return typeof navigator !== "undefined" && "geolocation" in navigator;
}

const GEO_ERROR_MAP = {
  1: { code: "denied", message: "Location permission denied. Enable GPS permission for AvSGo and try again." },
  2: { code: "unavailable", message: "Location unavailable right now. Please check GPS and try again." },
  3: { code: "timeout", message: "Location request timed out. Please try again." },
};

export async function getCurrentPosition(opts = {}) {
  const nativeGeo = await getNativeGeo();
  if (nativeGeo) {
    try {
      await nativeGeo.requestPermissions();
      const pos = await nativeGeo.getCurrentPosition({
        enableHighAccuracy: opts.enableHighAccuracy ?? DEFAULT_OPTS.enableHighAccuracy,
        timeout: opts.timeout ?? DEFAULT_OPTS.timeout,
        maximumAge: opts.maximumAge ?? DEFAULT_OPTS.maximumAge,
      });
      return { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
    } catch (err) {
      const e = new Error(err?.message || "Could not read your location.");
      e.code = err?.code || "error";
      throw e;
    }
  }

  return new Promise((resolve, reject) => {
    if (!isGeoSupported()) {
      const e = new Error("Location not supported on this device");
      e.code = "unsupported";
      return reject(e);
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
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

export function watchPosition(onUpdate, onError) {
  let nativeWatchId = null;
  let browserWatchId = null;
  let cancelled = false;

  (async () => {
    const nativeGeo = await getNativeGeo();
    if (cancelled) return;
    if (nativeGeo) {
      try {
        await nativeGeo.requestPermissions();
        nativeWatchId = await nativeGeo.watchPosition(
          { enableHighAccuracy: true, timeout: 20000, maximumAge: 15000 },
          (pos, err) => {
            if (err) { onError?.(err); return; }
            if (pos) onUpdate?.({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            });
          },
        );
        return;
      } catch (e) {
        onError?.(e);
        return;
      }
    }

    if (!isGeoSupported()) {
      onError?.(Object.assign(new Error("Location not supported on this device"), { code: "unsupported" }));
      return;
    }
    browserWatchId = navigator.geolocation.watchPosition(
      (pos) => onUpdate?.({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      }),
      (err) => onError?.(err),
      { ...DEFAULT_OPTS, maximumAge: 15000 },
    );
  })();

  return () => {
    cancelled = true;
    if (nativeWatchId !== null && CapacitorGeolocation) {
      CapacitorGeolocation.clearWatch({ id: nativeWatchId }).catch(() => {});
    }
    if (browserWatchId !== null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(browserWatchId); } catch (_) {}
    }
  };
}

export async function checkGeoPermission() {
  const nativeGeo = await getNativeGeo();
  if (nativeGeo) {
    try {
      const p = await nativeGeo.checkPermissions();
      return p.location || "unknown";
    } catch (_) { return "unknown"; }
  }
  if (typeof navigator === "undefined" || !navigator.permissions) return "unknown";
  try {
    const p = await navigator.permissions.query({ name: "geolocation" });
    return p.state;
  } catch (_) { return "unknown"; }
}

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
