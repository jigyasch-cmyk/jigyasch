import api from "@/lib/api";

const SW_URL = "/sw.js";

function urlB64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}

export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function getRegistration() {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  return await navigator.serviceWorker.register(SW_URL);
}

/**
 * Ask permission and subscribe the browser to Web Push for a given subscriber key.
 * subscriberKey formats:
 *  - "admin"
 *  - "driver:{id}"
 *  - "customer:{mobile}"
 */
export async function subscribeToPush(subscriberKey, opts = {}) {
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: "denied" };

    const reg = await getRegistration();
    // Get VAPID key
    const { data } = await api.get("/push/public-key");
    if (!data?.public_key) return { ok: false, reason: "no-key" };

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(data.public_key),
      });
    }

    const config = opts.role
      ? { headers: { "x-role": opts.role } }
      : undefined;
    await api.post(
      "/push/subscribe",
      { subscriber_key: subscriberKey, subscription: sub.toJSON() },
      config,
    );
    localStorage.setItem("avsgo_push_key", subscriberKey);
    return { ok: true };
  } catch (e) {
    if (typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production") {
      console.error("Push subscribe failed", e);
    }
    return { ok: false, reason: "error", error: e };
  }
}

export function pushPermission() {
  if (!pushSupported()) return "unsupported";
  return Notification.permission; // "granted" | "denied" | "default"
}
