import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Phone, User, IndianRupee, CheckCircle2, Clock, PhoneCall,
  XCircle, Navigation, Route as RouteIcon, Loader2, LocateFixed, Circle,
  Flag, Hash, X, ChevronRight, Bell,
} from "lucide-react";
import { toast } from "sonner";
import api, { wsUrl, fileUrl } from "@/lib/api";
import { subscribeToPush, pushSupported, pushPermission } from "@/lib/push";
import { getCurrentPosition, watchPosition, isGeoSupported } from "@/lib/geo";
import BookingMap from "@/components/BookingMap";
import LiveTripMap from "@/components/LiveTripMap";
import DropSearchOverlay from "@/components/DropSearchOverlay";

const VEHICLE_META = {
  "E-Rickshaw": { img: "https://images.unsplash.com/photo-1775880307727-afb09fe41d2c?auto=format&fit=crop&w=300&q=80", capacity: "up to 300 kg" },
  "Tata Ace": { img: "https://images.unsplash.com/photo-1601467995997-ac1ae9a8fff4?auto=format&fit=crop&w=300&q=80", capacity: "up to 750 kg" },
  "Tempo": { img: "https://images.unsplash.com/photo-1601467995997-ac1ae9a8fff4?auto=format&fit=crop&w=300&q=80", capacity: "up to 1500 kg" },
  "Tractor": { img: "https://images.unsplash.com/photo-1655048424706-bc5e4fc9f6b5?auto=format&fit=crop&w=300&q=80", capacity: "heavy load" },
};

export default function Customer() {
  const nav = useNavigate();
  // Flow: pickup/drop -> category -> fare/confirm -> booking status/live tracking.
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({ name: "", mobile: "" });
  const [onboardingDone, setOnboardingDone] = useState(false);
  const [onboardingBusy, setOnboardingBusy] = useState(false);

  const [pincode, setPincode] = useState("");
  const [pinArea, setPinArea] = useState(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState(null);

  const [pickup, setPickup] = useState(null);
  const [drop, setDrop] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [recenterKey, setRecenterKey] = useState(0);
  const [dropOverlayOpen, setDropOverlayOpen] = useState(false);
  const [pickupOverlayOpen, setPickupOverlayOpen] = useState(false);
  const [routeMeta, setRouteMeta] = useState(null);
  const [routeCalculating, setRouteCalculating] = useState(false);
  const [routeError, setRouteError] = useState(null);

  const [vehicleCategories, setVehicleCategories] = useState([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [vehicleType, setVehicleType] = useState("");
  const [fares, setFares] = useState([]);
  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tripState, setTripState] = useState(null);
  const [tripGeometry, setTripGeometry] = useState(null);
  const gpsAppliedRef = useRef(false);

  const fareCfg = useMemo(
    () => fares.find((f) => f.vehicle_type === vehicleType),
    [fares, vehicleType]
  );
  const distance = Number(routeMeta?.distance_km || 0);
  const estFare = fareCfg
    ? Math.round((Number(fareCfg.base_fare || 0) + Number(fareCfg.per_km || 0) * distance) * 100) / 100
    : 0;

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("avsgo_customer_profile") || "null");
      if (saved?.name && saved?.mobile) {
        setForm({ name: saved.name, mobile: saved.mobile });
        setOnboardingDone(true);
      }
      const savedPin = localStorage.getItem("avsgo_customer_pickup_pin");
      if (savedPin) setPincode(savedPin);
    } catch {}
    // Request location permission as soon as Customer opens. If allowed, cache
    // the GPS coordinates so the booking screen can use them as the default pickup.


    getCurrentPosition()
      .then(async (c) => {
        const current = {
          lat: Number(c.lat),
          lng: Number(c.lng),
          accuracy: c.accuracy,
        };

        setUserLocation(current);

        setPickup((previous) => {
          // Keep a manually selected pickup.
          if (previous && previous.source !== "gps") {
            return previous;
          }

          return {
            lat: current.lat,
            lng: current.lng,
            display_name: "Current location",
            id: null,
            source: "gps",
          };
        });

        try {
          const r = await api.get(
            `/reverse-geocode?lat=${current.lat}&lng=${current.lng}`
          );

          if (r.data?.display_name) {
            setPickup((previous) => {
              if (previous?.source !== "gps") return previous;

              return {
                ...previous,
                display_name: r.data.display_name,
              };
            });
          }
        } catch {
          // Keep GPS coordinates even if address lookup fails.
        }
      })
      .catch((e) => {
        toast.error(
          e?.message ||
            "Location unavailable. Allow GPS permission or select pickup manually."
        );
      });

          api.get("/fare-settings").then((r) => setFares(Array.isArray(r.data) ? r.data : [])).catch(() => {});
    api.get("/vehicle-categories")
      .then((r) => {
        const data = Array.isArray(r.data) ? r.data : [];
        setVehicleCategories(data.filter((c) => c && c.enabled !== false && c.name));
      })
      .catch(() => toast.error("Vehicle categories could not be loaded"))
      .finally(() => setCategoriesLoading(false));
  }, []);

  const resolvePincode = async (pin) => {
    setPinBusy(true);
    setPinError(null);
    try {
      const r = await api.get(`/pincode/${pin}`);
      const data = r.data;
      if (!data?.pincode) throw new Error("This PIN code is not an enabled AvSGo service area");
      setPinArea(data);
      setDrop(null);
    } catch (e) {
      setPinArea(null);
      setPinError(e.response?.data?.detail || e.message || "PIN code lookup failed");
    } finally {
      setPinBusy(false);
    }
  };

  useEffect(() => {
    if (onboardingDone) return;
    const pin = String(pincode || "").trim();
    if (!/^\d{6}$/.test(pin)) {
      setPinArea(null);
      setPinError(null);
      return;
    }
    if (pinArea?.pincode === pin) return;
    const timer = setTimeout(() => resolvePincode(pin), 450);
    return () => clearTimeout(timer);
    // resolvePincode reads current API helpers; PIN is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pincode, onboardingDone]);

  const completeOnboarding = async () => {
    const pin = pincode.trim();
    if (!/^\d{6}$/.test(pin)) return toast.error("Enter a valid 6-digit Pickup PIN");
    if (pinBusy) return;
    if (!pinArea?.pincode || String(pinArea.pincode) !== pin) {
      return toast.error("Wait for an enabled Pickup PIN to be verified");
    }
    if (!form.name.trim()) return toast.error("Enter your name");
    if (!/^\d{10}$/.test(form.mobile)) return toast.error("Enter a valid 10-digit mobile number");
    setOnboardingBusy(true);
    try {
      await api.post("/customer/register", {
        name: form.name.trim(),
        mobile: form.mobile,
        pickup_pin: pin,
      });
      localStorage.setItem("avsgo_customer_profile", JSON.stringify({
        name: form.name.trim(), mobile: form.mobile,
      }));
      localStorage.setItem("avsgo_customer_pickup_pin", pin);
      setOnboardingDone(true);
      toast.success("Customer saved • Service available");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Customer registration failed");
    } finally {
      setOnboardingBusy(false);
    }
  };


useEffect(() => {
  if (!onboardingDone || step !== 1 || !isGeoSupported()) return;

  const stop = watchPosition(async (c) => {
    const current = {
      lat: Number(c.lat),
      lng: Number(c.lng),
      accuracy: c.accuracy,
    };

    setUserLocation(current);

    if (gpsAppliedRef.current) return;

    setPickup((previous) => {
      if (previous && previous.source !== "gps") return previous;

      return {
        lat: current.lat,
        lng: current.lng,
        display_name: previous?.display_name || "Current location",
        id: null,
        source: "gps",
      };
    });

    try {
      const r = await api.get(
        `/reverse-geocode?lat=${current.lat}&lng=${current.lng}`
      );

      if (r.data?.display_name && !gpsAppliedRef.current) {
        setPickup((previous) => {
          if (previous?.source !== "gps") return previous;
          return { ...previous, display_name: r.data.display_name };
        });
      }
    } catch {}
  }, () => {});

  return () => {
    if (typeof stop === "function") stop();
  };
}, [onboardingDone, step]);

  
  const recenter = async () => {
    try {
      const c = userLocation || await getCurrentPosition();
      setUserLocation({ lat: c.lat, lng: c.lng, accuracy: c.accuracy });
      setRecenterKey((n) => n + 1);
    } catch (e) {
      toast.error(e.message || "Location unavailable");
    }
  };

  const handleMapDropChange = async ({ lat, lng }) => {
    setDrop({ lat, lng, display_name: "Locating…", id: null });
    try {
      const r = await api.get(`/reverse-geocode?lat=${lat}&lng=${lng}`);
      setDrop({
        lat, lng,
        display_name: r.data?.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
        id: null,
      });
    } catch {
      setDrop({ lat, lng, display_name: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, id: null });
    }
  };

  useEffect(() => {
    if (!pickup || !drop || !vehicleType) {
      setRouteMeta(null);
      setRouteError(null);
      setRouteCalculating(false);
      return;
    }
    let cancelled = false;
    setRouteCalculating(true);
    setRouteError(null);
    api.post("/route", {
      pickup_lat: pickup.lat,
      pickup_lng: pickup.lng,
      drop_lat: drop.lat,
      drop_lng: drop.lng,
      vehicle_type: vehicleType,
    }).then((r) => {
      if (!cancelled) setRouteMeta(r.data);
    }).catch((e) => {
      if (!cancelled) {
        setRouteMeta(null);
        setRouteError(e.response?.data?.detail || "Road distance could not be calculated. Please try again.");
      }
    }).finally(() => {
      if (!cancelled) setRouteCalculating(false);
    });
    return () => { cancelled = true; };
  }, [pickup, drop, vehicleType]);

  const continueToCategories = () => {
    if (!pickup || !Number.isFinite(Number(pickup.lat)) || !Number.isFinite(Number(pickup.lng))) {
      return toast.error("Select a valid pickup location");
    }
    if (!drop?.id) return toast.error("Select a Drop Place added by AvSGo Admin/Manager");
    setStep(2);
  };

  const chooseCategory = (name) => {
    setVehicleType(name);
    setRouteMeta(null);
    setRouteError(null);
    setStep(3);
  };

  const confirm = async () => {
    if (!form.name.trim() || !/^\d{10}$/.test(form.mobile)) {
      return toast.error("Please enter your name and valid 10-digit mobile number");
    }
    if (!pickup) return toast.error("Please select a pickup location");
    if (!drop?.id) return toast.error("Select a Drop Place from the AvSGo common place list");
    if (!vehicleType) return toast.error("Choose a vehicle category");
    if (routeError) return toast.error(routeError);
    if (routeCalculating || !routeMeta?.distance_km) {
      return toast.error("Wait for road distance to finish calculating");
    }
    if (!fareCfg) return toast.error("Fare for this category is not configured by Admin");
    setLoading(true);
    try {


  const r = await api.post("/customer/bookings/auto", {
    vehicle_type: vehicleType,
    customer_name: form.name.trim(),
    customer_mobile: form.mobile,
    pickup: pickup.display_name,
    drop_location: drop.display_name,
    drop_place_id: drop.id,
    distance_km: routeMeta.distance_km,
    pickup_lat: pickup.lat,
    pickup_lng: pickup.lng,
    pickup_pin: String(
      pincode ||
  localStorage.getItem("avsgo_customer_pickup_pin") ||
      ""
   ).trim(),
  });
            setBooking(r.data);
      try {
        localStorage.setItem("avsgo_customer_profile", JSON.stringify({
          name: form.name.trim(), mobile: form.mobile,
        }));
      } catch {}
      setStep(4);
      toast.success("Booking sent to nearby eligible drivers");
      if (pushSupported() && pushPermission() !== "denied") {
        subscribeToPush(`customer:${form.mobile}`).catch(() => {});
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Booking failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (step !== 4 || !booking?.id) return;
    let alive = true;
    const poll = async () => {
      try {
        const r = await api.get(`/customer/bookings/${booking.id}`);
        if (!alive) return;
        setBooking((old) => {
          if (old?.status === "requested" && r.data.status === "accepted") {
            toast.success("Driver accepted your booking!");
          }
          if (old?.status === "requested" && r.data.status === "rejected") {
            toast.error("Driver rejected your booking");
          }
          return r.data;
        });
      } catch {}
    };
    poll();
    const timer = setInterval(poll, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [step, booking?.id]);

  useEffect(() => {
    if (step !== 4 || !booking?.id ||
        !["accepted", "driver_to_pickup", "trip_started", "at_pickup", "in_trip"].includes(booking.status)) return;
    let alive = true;
    let lastSent = 0;
    let socket;
    const pollTrip = async () => {
      try {
        const r = await api.get(`/customer/bookings/${booking.id}/trip`, {
          params: { mobile: booking.customer_mobile || form.mobile },
        });
        if (alive) setTripState(r.data);
      } catch {}
    };
    pollTrip();
    const timer = setInterval(pollTrip, 5000);
    try {
      socket = new WebSocket(wsUrl("/api/ws/customer", {
        booking_id: booking.id,
        mobile: booking.customer_mobile || form.mobile,
      }));
      socket.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "driver_location") {
            setTripState((old) => old ? { ...old, driver_location: msg.data } : old);
          } else if (msg.type === "customer_location") {
            setTripState((old) => old ? { ...old, customer_location: msg.data } : old);
          } else if (["booking_updated", "trip_updated", "payment_updated"].includes(msg.type)) {
            pollTrip();
          }
        } catch {}
      };
    } catch {}
    let stopWatching;
    if (isGeoSupported()) {
      stopWatching = watchPosition((coords) => {
        if (Date.now() - lastSent < 3000) return;
        lastSent = Date.now();
        api.post("/customer/location", {
          customer_mobile: booking.customer_mobile || form.mobile,
          ...coords,
        }).catch(() => {});
      }, () => {});
    }
    return () => {
      alive = false;
      clearInterval(timer);
      try { socket?.close(); } catch {}
      if (typeof stopWatching === "function") stopWatching();
    };
  }, [step, booking?.id, booking?.status, booking?.customer_mobile, form.mobile]);

  useEffect(() => {
    if (!tripState) return;
    const stage = tripState.trip_stage;
    const from = stage === "in_trip" ? tripState.pickup : tripState.driver_location;
    const to = stage === "in_trip" ? tripState.drop : (tripState.customer_location || tripState.pickup);
    if (from?.lat == null || from?.lng == null || to?.lat == null || to?.lng == null) return;
    api.post("/route", {
      pickup_lat: from.lat, pickup_lng: from.lng,
      drop_lat: to.lat, drop_lng: to.lng,
    }).then((r) => setTripGeometry(r.data?.geometry || null)).catch(() => {});
  }, [
    tripState?.trip_stage,
    tripState?.driver_location?.lat, tripState?.driver_location?.lng,
    tripState?.customer_location?.lat, tripState?.customer_location?.lng,
  ]);

  if (!onboardingDone) {
    return (
      <div className="mobile-shell min-h-screen bg-white p-6">
        <div className="pt-8">
          <div className="h-14 w-14 rounded-2xl bg-emerald-100 flex items-center justify-center">
            <Hash className="h-7 w-7 text-emerald-600" />
          </div>
          <h1 className="font-display text-3xl font-bold mt-4">Welcome to AvSGo</h1>
          <p className="text-gray-500 mt-1">Check your Pickup PIN and save your customer details.</p>
        </div>
        <div className="mt-7 space-y-3">
          <label className="text-sm font-semibold">Pickup PIN</label>
          <input className="field" inputMode="numeric" maxLength={6}
            placeholder="6-digit Pickup PIN" value={pincode}
            onChange={(e) => setPincode(e.target.value.replace(/\D/g, "").slice(0, 6))} />
          {pinBusy && <div className="text-sm text-gray-500">Checking service availability…</div>}
          {pinArea?.pincode === pincode && (
            <div className="rounded-xl bg-emerald-50 text-emerald-700 p-3 text-sm font-semibold">
              ✓ Service Available — {pinArea.display_name || pinArea.pincode}
            </div>
          )}
          {pinError && <div className="rounded-xl bg-rose-50 text-rose-700 p-3 text-sm">{pinError}</div>}
          <label className="text-sm font-semibold block pt-2">Name</label>
          <input className="field" placeholder="Your name" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label className="text-sm font-semibold block pt-2">Mobile Number</label>
          <input className="field" inputMode="numeric" maxLength={10}
            placeholder="10-digit mobile number" value={form.mobile}
            onChange={(e) => setForm({ ...form, mobile: e.target.value.replace(/\D/g, "").slice(0, 10) })} />
          <button className="brand-btn w-full mt-3" disabled={onboardingBusy || pinBusy}
            onClick={completeOnboarding}>
            {onboardingBusy ? "Saving…" : "Continue & Save Customer"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-shell pb-24">
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="flex items-center gap-3 p-4">
          <button data-testid="customer-back-btn" onClick={() => step > 1 && step < 4 ? setStep(step - 1) : nav("/")}
            className="h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="text-xs uppercase tracking-wider text-gray-500">
              {step === 1 && "Booking details"}
              {step === 2 && "Choose category"}
              {step === 3 && "Fare & confirmation"}
              {step === 4 && "Booking status"}
            </div>
            <div className="font-display font-bold text-lg">
              {step === 1 && "Pickup & Drop"}
              {step === 2 && "Vehicle Category"}
              {step === 3 && "Review your booking"}
              {step === 4 && "Booking status"}
            </div>
          </div>
        </div>
      </div>

      {step === 1 && (
        <div className="p-4 space-y-4">
          <div className="space-y-2">
            <button data-testid="customer-pickup-search" onClick={() => setPickupOverlayOpen(true)}
              className="w-full flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-3 text-left transition hover:border-emerald-400">
              <Circle className="h-4 w-4 text-emerald-600 shrink-0" fill="#10b981" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Pickup</div>
                <div className={"text-sm truncate " + (pickup ? "font-semibold text-gray-800" : "text-gray-400")}>
                  {pickup?.display_name || "Select an AvSGo pickup place…"}
                </div>
              </div>
              {pickup ? <span role="button" tabIndex={0} data-testid="customer-pickup-clear-btn"
                onClick={(e) => { e.stopPropagation(); gpsAppliedRef.current = false; setPickup(userLocation ? { lat: userLocation.lat, lng: userLocation.lng, display_name: "Current location", id: null, source: "gps" } : null); }}
                className="h-6 w-6 rounded-full bg-gray-100 flex items-center justify-center">
                <X className="h-3.5 w-3.5 text-gray-600" />
              </span> : <ChevronRight className="h-5 w-5 text-gray-400 shrink-0" />}
            </button>
            <div className="text-[11px] text-gray-500 px-1">Pickup defaults to your current GPS location. Tap to choose a common place manually added by AvSGo Admin/Manager. Google Places is not used.</div>
            <button data-testid="customer-drop-search-btn"
              onClick={() => setDropOverlayOpen(true)}
              className="w-full flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-left transition hover:border-rose-400 active:scale-[0.997]">
              <Flag className="h-4 w-4 text-rose-600 shrink-0" fill="#e11d48" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Search Drop Location</div>
                <div className={"text-sm truncate " + (drop ? "font-semibold text-gray-800" : "text-gray-400")}>
                  {drop?.display_name || "Search and select a drop place…"}
                </div>
              </div>
              {drop ? <span role="button" tabIndex={0} data-testid="customer-drop-clear-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); setDrop(null); }}
                className="h-6 w-6 rounded-full bg-gray-100 flex items-center justify-center">
                <X className="h-3.5 w-3.5 text-gray-600" />
              </span> : <ChevronRight className="h-5 w-5 text-gray-400 shrink-0" />}
            </button>
          </div>

          <div className="relative">
            <BookingMap pickup={pickup} drop={drop} geometry={routeMeta?.geometry}
              userLocation={userLocation} pinArea={null} recenterKey={recenterKey}
              onDropChange={handleMapDropChange} height="h-72" />
            <button data-testid="customer-map-recenter-btn" onClick={recenter}
              className="absolute right-3 top-3 h-11 w-11 rounded-full bg-white shadow-md border border-gray-200 flex items-center justify-center"
              aria-label="Recenter to my location">
              <LocateFixed className="h-5 w-5 text-emerald-700" />
            </button>
            {!drop && <div className="absolute left-3 right-3 bottom-3 rounded-xl bg-white/95 border border-amber-200 shadow-md px-3 py-2 text-[11px] font-semibold text-amber-800">
              Select a Drop Place added by AvSGo Admin/Manager. No PIN restriction applies to drop location.
            </div>}
          </div>

          <button data-testid="customer-continue-category-btn" onClick={continueToCategories}
            className="brand-btn w-full">
            Continue to vehicle categories <ChevronRight className="inline h-4 w-4 ml-1" />
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="p-4 space-y-3">
          {categoriesLoading && <div className="text-center text-gray-500 py-6">Loading vehicle categories…</div>}
          {!categoriesLoading && vehicleCategories.length === 0 && (
            <div className="card text-center text-gray-500">No enabled vehicle categories. Please contact AvSGo Admin.</div>
          )}
          {!categoriesLoading && vehicleCategories.map((category) => {
            const type = category.name;
            const meta = VEHICLE_META[type];
            const fare = fares.find((f) => f.vehicle_type === type);
            return (
              <button key={category.id || type} data-testid={`customer-vehicle-type-${type.replace(/\s+/g, "-").toLowerCase()}`}
                onClick={() => chooseCategory(type)}
                className={"w-full flex items-center gap-3 rounded-2xl border p-3 text-left transition " +
                  (vehicleType === type ? "border-emerald-600 bg-emerald-50" : "border-gray-200 bg-white hover:border-emerald-500")}>
                
 <img
  src={
    category.image_file_id
      ? fileUrl(category.image_file_id)
      : (meta?.img || VEHICLE_META["Tata Ace"].img)
  }
  alt={type}
  className="h-16 w-16 rounded-xl object-cover"
 />
                <div className="flex-1 min-w-0">
                  <div className="font-display font-bold text-lg">{type}</div>
                  <div className="text-sm text-gray-500">{category.capacity || meta?.capacity || "Capacity not specified"}</div>
                  {fare && <div className="mt-1 text-xs text-emerald-700 font-semibold">₹{fare.base_fare} base + ₹{fare.per_km}/km</div>}
                </div>
                <ChevronRight className="h-5 w-5 text-gray-400" />
              </button>
            );
          })}
          <button className="brand-btn-outline w-full" onClick={() => setStep(1)}>Back to pickup & drop</button>
        </div>
      )}

      {step === 3 && (
        <div className="p-4 space-y-4">
          <div className="card space-y-2">
            <div className="flex justify-between gap-3"><span className="text-gray-500">Category</span><b>{vehicleType}</b></div>
            <div className="flex justify-between gap-3"><span className="text-gray-500">Pickup</span><span className="text-right font-semibold">{pickup?.display_name}</span></div>
            <div className="flex justify-between gap-3"><span className="text-gray-500">Drop</span><span className="text-right font-semibold">{drop?.display_name}</span></div>
            <div className="flex justify-between gap-3"><span className="text-gray-500">Road distance</span>
              <span className="font-semibold">
                {routeCalculating ? <Loader2 className="inline h-4 w-4 animate-spin" /> : routeMeta?.distance_km ? `${routeMeta.distance_km} km` : "—"}
              </span>
            </div>
            {routeError && <div className="text-sm text-rose-700">{routeError}</div>}
            {routeMeta?.duration_min && <div className="flex justify-between"><span className="text-gray-500">Estimated time</span><b>~{Math.round(routeMeta.duration_min)} min</b></div>}
          </div>
          <div className="card bg-emerald-50 border-emerald-200">
            <div className="text-xs uppercase tracking-wider text-emerald-800">Estimated fare (Admin rate)</div>
            <div className="font-display font-bold text-3xl text-emerald-700 flex items-center mt-1">
              <IndianRupee className="h-6 w-6" />{routeMeta?.distance_km && fareCfg ? estFare : "—"}
            </div>
            {fareCfg ? <div className="text-xs text-emerald-900 mt-2">Base ₹{fareCfg.base_fare} + ₹{fareCfg.per_km}/km × {distance} km</div>
              : <div className="text-sm text-rose-700 mt-2">Admin has not configured a fare for this category.</div>}
          </div>
          <div className="card space-y-3">
            <Field icon={<User className="h-5 w-5" />} placeholder="Your name" testid="customer-name"
              value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <Field icon={<Phone className="h-5 w-5" />} placeholder="10-digit mobile" testid="customer-mobile"
              value={form.mobile} onChange={(v) => setForm({ ...form, mobile: v.replace(/\D/g, "").slice(0, 10) })}
              inputMode="numeric" />
          </div>
          <button data-testid="customer-confirm-btn" onClick={confirm}
            disabled={loading || routeCalculating || !routeMeta?.distance_km || !fareCfg}
            className="brand-btn w-full disabled:opacity-60">
            {loading ? "Sending booking request…" : "Confirm booking request"}
          </button>
          <button className="brand-btn-outline w-full" onClick={() => setStep(2)}>Change vehicle category</button>
        </div>
      )}

      <DropSearchOverlay open={dropOverlayOpen} onClose={() => setDropOverlayOpen(false)}
        onSelect={(loc) => { setDrop(loc); setDropOverlayOpen(false); }} />
      <DropSearchOverlay open={pickupOverlayOpen} onClose={() => setPickupOverlayOpen(false)}
        onSelect={(loc) => { gpsAppliedRef.current = true; setPickup(loc); setPickupOverlayOpen(false); }} />

      {step === 4 && booking && (
        <div className="p-5 space-y-4">
          <PushEnableBanner subscriberKey={`customer:${booking.customer_mobile || form.mobile}`} />
          {booking.status === "requested" && <div className="card text-center">
            <Clock className="h-14 w-14 text-amber-500 mx-auto animate-pulse" />
            <h2 className="font-display text-xl font-bold mt-3">Waiting for driver…</h2>
            <p className="text-gray-500 text-sm mt-1">AvSGo is notifying nearby eligible drivers. The first valid driver to accept gets the booking.</p>
            <div className="mt-2 text-xs text-gray-400">Booking ID: {String(booking.id || "").slice(0, 8)}</div>
          </div>}
          {["accepted", "driver_to_pickup", "trip_started", "at_pickup", "in_trip"].includes(booking.status) && (
            <div className="card border-emerald-500 border-2">
              <CheckCircle2 className="h-14 w-14 text-emerald-600 mx-auto" />
              <h2 className="font-display text-xl font-bold mt-3 text-center">Driver accepted!</h2>
              <p className="text-center text-gray-500 text-sm mt-1">Call the driver to coordinate pickup.</p>
              {booking.driver_mobile && <div className="mt-4 p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-center">
                <div className="text-xs uppercase tracking-wider text-emerald-800">Driver Mobile</div>
                <div className="font-display font-bold text-2xl text-emerald-800 mt-1">{booking.driver_mobile}</div>
              </div>}
              {booking.driver_mobile && <a href={`tel:${booking.driver_mobile}`} className="brand-btn w-full mt-4 flex items-center justify-center gap-2">
                <PhoneCall className="h-5 w-5" /> Call driver
              </a>}
              {tripState && <div className="mt-4">
                <LiveTripMap pickup={tripState.pickup?.lat != null ? { lat: tripState.pickup.lat, lng: tripState.pickup.lng } : null}
                  drop={tripState.drop?.lat != null ? { lat: tripState.drop.lat, lng: tripState.drop.lng } : null}
                  driverLocation={tripState.driver_location} customerLocation={tripState.customer_location}
                  geometry={tripGeometry} stage={tripState.trip_stage} />
              </div>}
              {tripState?.trip_stage === "at_pickup" && tripState?.status !== "completed" && (
                <button data-testid="customer-start-trip-btn" className="brand-btn w-full mt-3"
                  onClick={async () => {
                    try {
                      const r = await api.post(`/customer/bookings/${booking.id}/start-trip`, null, {
                        params: { mobile: booking.customer_mobile || form.mobile },
                      });
                      setBooking(r.data);
                      toast.success("Trip started");
                    } catch (e) {
                      toast.error(e.response?.data?.detail || "Driver has not reached pickup yet");
                    }
                  }}>Start Trip</button>
              )}
            </div>
          )}
          {booking.status === "rejected" && <div className="card text-center border-rose-300">
            <XCircle className="h-14 w-14 text-rose-500 mx-auto" />
            <h2 className="font-display text-xl font-bold mt-3">Booking rejected</h2>
            <p className="text-gray-500 text-sm mt-1">Please choose a category and try again.</p>
            <button className="brand-btn-outline mt-4" onClick={() => { setBooking(null); setStep(2); }}>Choose another category</button>
          </div>}
          {booking.status === "completed" && <div className="card text-center">
            <CheckCircle2 className="h-14 w-14 text-emerald-600 mx-auto" />
            <h2 className="font-display text-xl font-bold mt-3">Trip completed</h2>
            <p className="text-gray-500 text-sm">Thanks for using AvSGo!</p>
          </div>}
          <div className="card text-sm space-y-1">
            <div className="flex justify-between"><span className="text-gray-500">Vehicle category</span><span className="font-semibold">{booking.vehicle_type}</span></div>
            <div className="flex justify-between gap-2"><span className="text-gray-500 shrink-0">Pickup</span><span className="font-semibold text-right">{booking.pickup}</span></div>
            <div className="flex justify-between gap-2"><span className="text-gray-500 shrink-0">Drop</span><span className="font-semibold text-right">{booking.drop_location}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Distance</span><span className="font-semibold">{booking.distance_km} km</span></div>
            <div className="flex justify-between pt-2 border-t mt-2"><span className="text-gray-500">Fare</span><span className="font-display font-bold text-emerald-700">₹{booking.fare}</span></div>
          </div>
          <Link to="/" className="brand-btn-outline w-full">Back to home</Link>
        </div>
      )}
    </div>
  );
}

function PinCodeField({ value, onChange, busy, error, resolved }) {
  const ok = !!resolved && String(resolved.pincode) === String(value);
  return (
    <div className="space-y-1">
      <div className={"flex items-center gap-3 rounded-xl border bg-white px-3 py-2.5 transition " +
        (ok ? "border-emerald-500" : error ? "border-rose-400" : "border-gray-200 focus-within:border-amber-500")}>
        <Hash className="h-4 w-4 text-amber-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Pickup PIN Code (service area)</div>
          <input data-testid="customer-pincode-input" className="w-full bg-transparent outline-none text-sm font-semibold text-gray-800 placeholder-gray-400"
            value={value} onChange={(e) => onChange(e.target.value)} inputMode="numeric" maxLength={6}
            placeholder="6-digit Pickup PIN e.g. 784161" />
        </div>
        {busy && <Loader2 className="h-4 w-4 animate-spin text-amber-600" />}
        {ok && <CheckCircle2 className="h-5 w-5 text-emerald-600" />}
      </div>
      {error && <div className="text-xs text-rose-600">{error}</div>}
      {ok && <div className="text-xs text-emerald-700">Service area verified</div>}
    </div>
  );
}

function Field({ icon, placeholder, value, onChange, testid, inputMode }) {
  return (
    <label className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-3">
      <span className="text-gray-400">{icon}</span>
      <input data-testid={testid} className="w-full bg-transparent outline-none text-sm"
        placeholder={placeholder} value={value} inputMode={inputMode || "text"}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

function PushEnableBanner({ subscriberKey }) {
  const [state, setState] = useState(pushPermission());
  const enable = async () => {
    const result = await subscribeToPush(subscriberKey);
    setState(pushPermission());
    if (result?.ok) toast.success("You'll get push updates for this booking");
    else if (result?.reason === "denied") toast.error("Notifications blocked in browser settings");
    else if (result?.reason) toast.error("Could not enable notifications");
  };
  if (!pushSupported() || state === "granted") return null;
  return (
    <button data-testid="customer-enable-push-btn" onClick={enable}
      className="w-full flex items-center gap-3 p-3 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm font-semibold hover:bg-emerald-100">
      <Bell className="h-5 w-5" /> Enable push notifications for this booking
    </button>
  );
}
