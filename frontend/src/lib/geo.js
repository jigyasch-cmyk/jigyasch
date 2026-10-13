 /**
 * AvSGo Geolocation — Android APK + Browser/PWA
 */
import { Capacitor } from "@capacitor/core";
import { Geolocation } from "@capacitor/geolocation";

const DEFAULT_OPTS = {
  enableHighAccuracy: true,
  timeout: 20000,
  maximumAge: 0,
};

export function isGeoSupported() {
  return Capacitor.isNativePlatform() ||
    (typeof navigator !== "undefined" &&
      "geolocation" in navigator);
}

function isNative() {
  return Capacitor.isNativePlatform();
}

async function requestLocationPermission() {
  if (!isNative()) return true;

  let permission = await Geolocation.checkPermissions();

  if (
    permission.location !== "granted" &&
    permission.coarseLocation !== "granted"
  ) {
    permission = await Geolocation.requestPermissions();
  }

  if (
    permission.location !== "granted" &&
    permission.coarseLocation !== "granted"
  ) {
    throw new Error(
      "Location permission denied. Enable Location for AvSGo in Settings."
    );
  }

  return true;
}

export async function getCurrentPosition(opts = {}) {
  const options = { ...DEFAULT_OPTS, ...opts };

  if (isNative()) {
    await requestLocationPermission();

    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: options.enableHighAccuracy,
      timeout: options.timeout,
      maximumAge: options.maximumAge,
    });

    return {
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    };
  }

  if (!isGeoSupported()) {
    throw new Error("Location is not supported on this device.");
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      (err) => {
        const messages = {
          1: "Location permission denied. Allow location for AvSGo.",
          2: "Location unavailable. Turn on GPS/Location and try again.",
          3: "GPS timed out. Move to an open area and try again.",
        };

        reject(
          new Error(
            messages[err.code] || "Could not get current GPS location."
          )
        );
      },
      options
    );
  });
}

export function watchPosition(onUpdate, onError) {
  let watchId = null;
  let cancelled = false;

  const start = async () => {
    try {
      if (isNative()) {
        await requestLocationPermission();
        if (cancelled) return;

        watchId = await Geolocation.watchPosition(
          {
            enableHighAccuracy: true,
            timeout: 20000,
            maximumAge: 0,
          },
          (pos, err) => {
            if (cancelled) return;

            if (err) {
              onError?.(err);
              return;
            }

            if (pos) {
              onUpdate?.({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
              });
            }
          }
        );
      } else {
        if (!navigator.geolocation) {
          throw new Error("Location is not supported on this device.");
        }

        watchId = navigator.geolocation.watchPosition(
          (pos) => {
            if (cancelled) return;

            onUpdate?.({
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            });
          },
          (err) => onError?.(err),
          { ...DEFAULT_OPTS }
        );
      }
    } catch (err) {
      if (!cancelled) onError?.(err);
    }
  };

  start();

  return () => {
    cancelled = true;

    if (watchId === null) return;

    if (isNative()) {
      Geolocation.clearWatch({ id: watchId }).catch(() => {});
    } else if (navigator.geolocation) {
      navigator.geolocation.clearWatch(watchId);
    }
  };
}

export async function checkGeoPermission() {
  if (isNative()) {
    try {
      const p = await Geolocation.checkPermissions();
      return p.location || p.coarseLocation || "unknown";
    } catch {
      return "unknown";
    }
  }

  if (!navigator.permissions) return "unknown";

  try {
    const p = await navigator.permissions.query({
      name: "geolocation",
    });
    return p.state;
  } catch {
    return "unknown";
  }
}

export function haversineMeters(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) *
      Math.cos(toRad(b.lat)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}
