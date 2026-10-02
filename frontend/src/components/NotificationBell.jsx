import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Check, CheckCheck, Volume2, VolumeX, Moon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import api from "@/lib/api";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

const SOUND_KEY = "avsgo_bell_sound";
const QUIET_KEY = "avsgo_bell_quiet";

/** ---------- Quiet hours helpers ---------- */
function readQuiet() {
  try {
    const raw = localStorage.getItem(QUIET_KEY);
    if (!raw) return { enabled: false, from: "22:00", to: "07:00" };
    const p = JSON.parse(raw);
    return {
      enabled: !!p.enabled,
      from: typeof p.from === "string" ? p.from : "22:00",
      to: typeof p.to === "string" ? p.to : "07:00",
    };
  } catch (_) {
    return { enabled: false, from: "22:00", to: "07:00" };
  }
}

function toMin(t) {
  const [h, m] = (t || "0:0").split(":").map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
}

/** True if current local time is inside the quiet window (supports crossing midnight). */
function isQuietNow(cfg) {
  if (!cfg?.enabled) return false;
  const d = new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  const f = toMin(cfg.from);
  const t = toMin(cfg.to);
  if (f === t) return false;
  return f < t ? cur >= f && cur < t : cur >= f || cur < t;
}

/** ---------- Audio ---------- */
let _audioCtx = null;
function getAudioCtx() {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!_audioCtx) _audioCtx = new AC();
  return _audioCtx;
}

function playChime() {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const play = () => {
    const now = ctx.currentTime;
    const beep = (freq, start, dur = 0.18) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + start);
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.35, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    };
    beep(880, 0);
    beep(1320, 0.14);
  };
  if (ctx.state === "suspended") ctx.resume().then(play).catch((e) => {
    if (typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production") {
      console.debug("[Bell] audio resume failed:", e);
    }
  });
  else play();
}

/** ---------- Bell ---------- */
export default function NotificationBell({ role }) {
  const nav = useNavigate();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(SOUND_KEY) !== "off");
  const [quiet, setQuiet] = useState(readQuiet);
  const [quietOpen, setQuietOpen] = useState(false);
  const timerRef = useRef(null);
  const lastSeenIdRef = useRef(null);
  const initializedRef = useRef(false);

  const config = { headers: { "x-role": role } };

  const load = async () => {
    try {
      const { data } = await api.get("/inapp/notifications", config);
      const list = data.items || [];
      const newestId = list[0]?.id || null;

      if (!initializedRef.current) {
        initializedRef.current = true;
      } else if (newestId && newestId !== lastSeenIdRef.current) {
        const muted = !soundOn || isQuietNow(quiet);
        if (!muted) {
          playChime();
          if (typeof navigator !== "undefined" && navigator.vibrate) {
            try {
              navigator.vibrate([80, 40, 80]);
            } catch (e) {
              if (process.env.NODE_ENV !== "production") {
                console.debug("[Bell] vibrate failed:", e);
              }
            }
          }
        }
      }
      lastSeenIdRef.current = newestId;
      setItems(list);
      setUnread(data.unread || 0);
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.debug("[Bell] load failed:", e);
      }
    }
  };

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 8000);
    const warm = () => {
      const ctx = getAudioCtx();
      if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
      window.removeEventListener("pointerdown", warm);
      window.removeEventListener("keydown", warm);
    };
    window.addEventListener("pointerdown", warm, { once: true });
    window.addEventListener("keydown", warm, { once: true });
    return () => {
      clearInterval(timerRef.current);
      window.removeEventListener("pointerdown", warm);
      window.removeEventListener("keydown", warm);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
  }, [soundOn]);

  useEffect(() => {
    localStorage.setItem(QUIET_KEY, JSON.stringify(quiet));
  }, [quiet]);

  const inQuiet = useMemo(() => isQuietNow(quiet), [quiet]);

  const markAll = async () => {
    try {
      await api.post("/inapp/notifications/mark-read", {}, config);
      setItems((xs) => xs.map((x) => ({ ...x, read: true })));
      setUnread(0);
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[Bell] mark-all failed:", e);
      }
    }
  };

  const clickItem = async (n) => {
    if (!n.read) {
      try {
        await api.post("/inapp/notifications/mark-read", { id: n.id }, config);
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          console.warn("[Bell] mark-read failed:", e);
        }
      }
    }
    setOpen(false);
    load();
    if (n.url) nav(n.url);
  };

  const toggleSound = () => {
    setSoundOn((s) => {
      const next = !s;
      if (next && !isQuietNow(quiet)) playChime();
      return next;
    });
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            data-testid={`${role}-bell-btn`}
            aria-label={`Notifications (${unread} unread)`}
            className="relative h-10 w-10 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center transition"
          >
            <Bell className="h-5 w-5 text-gray-700" />
            {unread > 0 && (
              <span
                data-testid={`${role}-bell-badge`}
                className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold flex items-center justify-center"
              >
                {unread > 9 ? "9+" : unread}
              </span>
            )}
            {quiet.enabled && (
              <span
                data-testid={`${role}-bell-quiet-dot`}
                aria-label="Quiet hours enabled"
                className="absolute -bottom-0.5 -right-0.5 h-[10px] w-[10px] rounded-full bg-indigo-500 ring-2 ring-white"
              />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={8}
          className="w-[92vw] sm:w-96 p-0 rounded-2xl overflow-hidden"
          data-testid={`${role}-bell-panel`}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div>
              <div className="font-display font-bold text-base">Notifications</div>
              <div className="text-xs text-gray-500 flex items-center gap-2">
                {unread} unread
                {inQuiet && (
                  <span
                    data-testid={`${role}-bell-quiet-active`}
                    className="chip bg-indigo-100 text-indigo-700 px-2 py-0.5"
                  >
                    <Moon className="h-3 w-3 inline mr-1" /> Quiet hours
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                data-testid={`${role}-bell-quiet-btn`}
                onClick={() => setQuietOpen(true)}
                aria-label="Quiet hours settings"
                title="Quiet hours"
                className={`h-9 w-9 rounded-lg flex items-center justify-center transition ${
                  quiet.enabled ? "text-indigo-700 bg-indigo-50 hover:bg-indigo-100" : "text-gray-500 hover:bg-gray-100"
                }`}
              >
                <Moon className="h-4 w-4" />
              </button>
              <button
                data-testid={`${role}-bell-sound-toggle`}
                onClick={toggleSound}
                aria-label={soundOn ? "Mute chime" : "Unmute chime"}
                title={soundOn ? "Chime on — tap to mute" : "Chime muted — tap to enable"}
                className={`h-9 w-9 rounded-lg flex items-center justify-center transition ${
                  soundOn ? "text-emerald-700 hover:bg-emerald-50" : "text-gray-400 hover:bg-gray-100"
                }`}
              >
                {soundOn ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
              {unread > 0 && (
                <button
                  data-testid={`${role}-bell-mark-all`}
                  onClick={markAll}
                  className="text-xs font-semibold text-emerald-700 hover:text-emerald-800 flex items-center gap-1 px-2 h-9 rounded-lg hover:bg-emerald-50"
                >
                  <CheckCheck className="h-4 w-4" /> Mark all read
                </button>
              )}
            </div>
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 && (
              <div className="p-8 text-center text-sm text-gray-500">
                <Bell className="h-8 w-8 mx-auto text-gray-300 mb-2" />
                You have no notifications yet.
              </div>
            )}
            {items.map((n) => (
              <button
                key={n.id}
                data-testid={`bell-item-${n.id}`}
                onClick={() => clickItem(n)}
                className={`w-full text-left px-4 py-3 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 transition flex gap-3 ${
                  !n.read ? "bg-emerald-50/40" : ""
                }`}
              >
                <div className="mt-1">
                  {n.read ? (
                    <Check className="h-4 w-4 text-gray-300" />
                  ) : (
                    <span className="block h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-semibold truncate ${n.read ? "text-gray-600" : "text-gray-900"}`}>
                    {n.title}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">{n.body}</div>
                  <div className="text-[10px] text-gray-400 mt-1">
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      <QuietHoursDialog
        role={role}
        open={quietOpen}
        onOpenChange={setQuietOpen}
        value={quiet}
        onChange={setQuiet}
      />
    </>
  );
}

function QuietHoursDialog({ role, open, onOpenChange, value, onChange }) {
  const [local, setLocal] = useState(value);
  useEffect(() => { if (open) setLocal(value); }, [open, value]);

  const save = () => {
    onChange(local);
    onOpenChange(false);
  };

  const label = useMemo(() => {
    if (!local.enabled) return "Off";
    return `${local.from} → ${local.to}${toMin(local.from) >= toMin(local.to) ? " (next day)" : ""}`;
  }, [local]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-2xl" data-testid={`${role}-quiet-dialog`}>
        <DialogHeader>
          <DialogTitle className="font-display text-xl flex items-center gap-2">
            <Moon className="h-5 w-5 text-indigo-600" /> Quiet hours
          </DialogTitle>
          <DialogDescription>
            During this window your chime and vibration stay muted, but new notifications still land in the bell so you never miss a booking.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-2 space-y-4">
          <div className="flex items-center justify-between p-3 rounded-xl border border-gray-200">
            <div>
              <div className="font-semibold text-sm">Enable quiet hours</div>
              <div className="text-xs text-gray-500">Currently: {label}</div>
            </div>
            <Switch
              data-testid={`${role}-quiet-enable-switch`}
              checked={local.enabled}
              onCheckedChange={(v) => setLocal((x) => ({ ...x, enabled: v }))}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-xs text-gray-500 mb-1">From</div>
              <input
                data-testid={`${role}-quiet-from`}
                type="time"
                disabled={!local.enabled}
                value={local.from}
                onChange={(e) => setLocal((x) => ({ ...x, from: e.target.value }))}
                className="field disabled:opacity-50"
              />
            </label>
            <label className="block">
              <div className="text-xs text-gray-500 mb-1">To</div>
              <input
                data-testid={`${role}-quiet-to`}
                type="time"
                disabled={!local.enabled}
                value={local.to}
                onChange={(e) => setLocal((x) => ({ ...x, to: e.target.value }))}
                className="field disabled:opacity-50"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            {[
              ["Night", "22:00", "07:00"],
              ["Late night", "23:00", "06:00"],
              ["Afternoon nap", "13:00", "15:00"],
            ].map(([lbl, f, t]) => (
              <button
                key={lbl}
                data-testid={`${role}-quiet-preset-${lbl.replace(/\s+/g, "-").toLowerCase()}`}
                onClick={() => setLocal({ enabled: true, from: f, to: t })}
                className="chip bg-indigo-50 text-indigo-700 hover:bg-indigo-100 px-3 py-1.5"
              >
                {lbl} · {f}–{t}
              </button>
            ))}
          </div>
        </div>

        <DialogFooter className="mt-4 flex gap-2">
          <button
            data-testid={`${role}-quiet-cancel`}
            onClick={() => onOpenChange(false)}
            className="h-11 flex-1 rounded-xl border border-gray-200 font-semibold hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            data-testid={`${role}-quiet-save`}
            onClick={save}
            className="brand-btn flex-1 h-11"
          >
            Save
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
