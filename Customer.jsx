import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Phone, User, IndianRupee, CheckCircle2, Clock, PhoneCall, XCircle,
  Bell, Navigation, Sparkles, Route as RouteIcon, Loader2, LocateFixed, Circle,
  Flag, Hash, CheckCircle, X, ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import api, { wsUrl } from "@/lib/api";
import { subscribeToPush, pushSupported, pushPermission } from "@/lib/push";
import { getCurrentPosition, watchPosition, isGeoSupported } from "@/lib/geo";
import BookingMap from "@/components/BookingMap";
import LiveTripMap from "@/components/LiveTripMap";
import LocationSearchBar from "@/components/LocationSearchBar";
import DropSearchOverlay from "@/components/DropSearchOverlay";

const VEHICLE_META = {
  "E-Rickshaw": { img: "https://images.unsplash.com/photo-1775880307727-afb09fe41d2c?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1Mjh8MHwxfHNlYXJjaHwyfHxlbGVjdHJpYyUyMHJpY2tzaGF3JTIwdHJhbnNwb3J0fGVufDB8fHx8MTc4NjM3NTY1NXww&ixlib=rb-4.1.0&q=85", capacity: "up to 300 kg" },
  "Tata Ace":   { img: "https://images.unsplash.com/photo-1601467995997-ac1ae9a8fff4?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA3MDB8MHwxfHNlYXJjaHwxfHxzbWFsbCUyMGNvbW1lcmNpYWwlMjBkZWxpdmVyeSUyMHRydWNrfGVufDB8fHx8MTc4NjM3NTY1NXww&ixlib=rb-4.1.0&q=85", capacity: "up to 750 kg" },
  "Tempo":      { img: "https://images.unsplash.com/photo-1601467995997-ac1ae9a8fff4?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA3MDB8MHwxfHNlYXJjaHwxfHxzbWFsbCUyMGNvbW1lcmNpYWwlMjBkZWxpdmVyeSUyMHRydWNrfGVufDB8fHx8MTc4NjM3NTY1NXww&ixlib=rb-4.1.0&q=85", capacity: "up to 1500 kg" },
  "Tractor":    { img: "https://images.unsplash.com/photo-1655048424706-bc5e4fc9f6b5?crop=entropy&cs=srgb&fm=jpg&ixid=M3w3NTY2NzV8MHwxfHNlYXJjaHwyfHx0cmFjdG9yJTIwdHJhbnNwb3J0fGVufDB8fHx8MTc4NjM3NTY1NXww&ixlib=rb-4.1.0&q=85", capacity: "heavy load" },
};

export default function Customer() {
  const nav = useNavigate();
  const [step, setStep] = useState(3);
  const [vehicleType, setVehicleType] = useState(null);
  const [vehicles, setVehicles] = useState([]);

  const [vehicleCategories, setVehicleCategories] = useState([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [selectedVehicle, setSelectedVehicle] = useState(null);
  const [fares, setFares] = useState([]);
  const [form, setForm] = useState({ name: "", mobile: "" });
  const [pickup, setPickup] = useState(null);
  const [drop, setDrop] = useState(null);
  const [pincode, setPincode] = useState("");
  const [pinArea, setPinArea] = useState(null); // {pincode, display_name, lat, lng, bbox}
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [recenterKey, setRecenterKey] = useState(0);
  const [routeMeta, setRouteMeta] = useState(null);
  const [routeCalculating, setRouteCalculating] = useState(false);
  const [routeError, setRouteError] = useState(null);
  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoMode, setAutoMode] = useState(false);
  const [locLoading, setLocLoading] = useState(false);
  const [dropOverlayOpen, setDropOverlayOpen] = useState(false);
  const [dropPlaces, setDropPlaces] = useState([]);
  const [tripState, setTripState] = useState(null);
  const [tripGeometry, setTripGeometry] = useState(null);
  const gpsAppliedRef = useRef(false);
  const [onboardingDone, setOnboardingDone] = useState(false);
  const [onboardingBusy, setOnboardingBusy] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("avsgo_customer_profile") || "null");
      if (saved?.name && saved?.mobile) {
        setForm({ name: saved.name, mobile: saved.mobile });
        setOnboardingDone(true);
        setStep(3);
      }
      const savedPin = localStorage.getItem("avsgo_customer_pickup_pin");
      if (savedPin) setPincode(savedPin);
    } catch {}
    api.get("/fare-settings").then((r) => setFares(r.data)).catch(() => {});


    api.get("/vehicle-categories")
      .then((r) => {
        const data = Array.isArray(r.data) ? r.data : [];
        setVehicleCategories(
          data.filter(
            (category) => category.enabled !== false && category.name
          )
        );
      })
      .catch(() => toast.error("Vehicle categories load নহ'ল"))
      .finally(() => 
    setCategoriesLoading(false));
    api.get("/drop-places").then((r) => setDropPlaces(r.data || [])).catch(() => {});
  }, []);

  const fareCfg = useMemo(() => fares.find((f) => f.vehicle_type === vehicleType), [fares, vehicleType]);

  // Watch GPS from step 3 → blue dot + first-time pickup default
  useEffect(() => {
    if (step !== 3 || !isGeoSupported()) return;
    const unsub = watchPosition(
      async (c) => {
        setUserLocation({ lat: c.lat, lng: c.lng, accuracy: c.accuracy });
        if (!gpsAppliedRef.current && !pickup) {
          gpsAppliedRef.current = true;
          try {
            const r = await api.get(`/reverse-geocode?lat=${c.lat}&lng=${c.lng}`);
            setPickup({ lat: c.lat, lng: c.lng, display_name: r.data?.display_name || "Current location" });
          } catch {
            setPickup({ lat: c.lat, lng: c.lng, display_name: "Current location" });
          }
        }
      },
      () => {},
    );
    return () => unsub && unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // Recalculate road route on any change to pickup / drop / vehicle
  useEffect(() => {
    if (!pickup || !drop || !vehicleType) {
      setRouteMeta(null); setRouteError(null); setRouteCalculating(false);
      return;
    }
    setRouteCalculating(true); setRouteError(null);
    let cancelled = false;
    (async () => {
      try {
        const r = await api.post("/route", {
          pickup_lat: pickup.lat, pickup_lng: pickup.lng,
          drop_lat: drop.lat, drop_lng: drop.lng,
          vehicle_type: vehicleType,
        });
        if (!cancelled) setRouteMeta(r.data);
      } catch (err) {
        if (!cancelled) {
          setRouteError(err.response?.data?.detail || "Routing service unavailable. Please try again.");
          setRouteMeta(null);
        }
      } finally {
        if (!cancelled) setRouteCalculating(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pickup, drop, vehicleType]);

  const distance = routeMeta?.distance_km || 0;
  const estFare = fareCfg ? Math.round((fareCfg.base_fare + fareCfg.per_km * distance) * 100) / 100 : 0;


  const pickType = (type) => {
    setVehicleType(type);
    setSelectedVehicle(null);
    setAutoMode(true);
    setStep(3);
  };

  
  const goDetails = (v) => { setSelectedVehicle(v); setAutoMode(false); setStep(3); };

  const startAutoAssign = async () => {
    setLocLoading(true);
    try {
      const coords = await getCurrentPosition();
      setUserLocation({ lat: coords.lat, lng: coords.lng, accuracy: coords.accuracy });
      try {
        const r = await api.get(`/reverse-geocode?lat=${coords.lat}&lng=${coords.lng}`);
        setPickup({ lat: coords.lat, lng: coords.lng, display_name: r.data?.display_name || "Current location" });
      } catch {
        setPickup({ lat: coords.lat, lng: coords.lng, display_name: "Current location" });
      }
      gpsAppliedRef.current = true;
      setSelectedVehicle(null); setAutoMode(true); setStep(3);
      toast.success("Pickup set to your current location");
    } catch (e) {
      toast.error(e.message || "Could not read your location");
    } finally { setLocLoading(false); }
  };

  const recenter = async () => {
    try {
      const c = userLocation || (await getCurrentPosition());
      setUserLocation({ lat: c.lat, lng: c.lng, accuracy: c.accuracy });
      setRecenterKey((k) => k + 1);
    } catch (e) {
      toast.error(e.message || "Location unavailable");
    }
  };

  const useCurrentAsPickup = async () => {
    try {
      const c = userLocation || (await getCurrentPosition());
      setUserLocation({ lat: c.lat, lng: c.lng, accuracy: c.accuracy });
      const r = await api.get(`/reverse-geocode?lat=${c.lat}&lng=${c.lng}`);
      setPickup({ lat: c.lat, lng: c.lng, display_name: r.data?.display_name || "Current location" });
      gpsAppliedRef.current = true;
      toast.success("Pickup set to your current location");
    } catch (e) {
      toast.error(e.message || "Could not read your location");
    }
  };

  const completeOnboarding = async () => {
    const pin = pincode.trim();
    if (!/^\d{6}$/.test(pin)) return toast.error("Enter a valid 6-digit Pickup PIN");
    if (!pinArea?.pincode) return toast.error("This Pickup PIN is not an enabled AvSGo service area");
    if (!form.name.trim()) return toast.error("Enter your name");
    if (!/^\d{10}$/.test(form.mobile)) return toast.error("Enter a valid 10-digit mobile number");
    setOnboardingBusy(true);
    try {
      await api.post("/customer/register", { name: form.name.trim(), mobile: form.mobile, pickup_pin: pin });
      localStorage.setItem("avsgo_customer_profile", JSON.stringify({name: form.name.trim(), mobile: form.mobile}));
      localStorage.setItem("avsgo_customer_pickup_pin", pin);
      setOnboardingDone(true);
      setStep(3);
      toast.success("Customer saved • Service available");
    } finally { setOnboardingBusy(false); }
  };

  const resolvePincode = async (pin) => {
    setPinBusy(true); setPinError(null);
    try {
      const r = await api.get(`/pincode/${pin}`);
      setPinArea(r.data);
      setDrop(null); // reset drop — PIN is only an area hint, not the destination
      toast.success(`PIN ${pin} • ${(r.data.address?.state_district || r.data.address?.county || "area")} resolved`);
    } catch (e) {
      setPinArea(null);
      setPinError(e.response?.data?.detail || "PIN code lookup failed");
    } finally { setPinBusy(false); }
  };

  // Debounce PIN resolution
  useEffect(() => {
    const p = (pincode || "").trim();
    if (p.length !== 6 || !/^\d{6}$/.test(p)) {
      setPinArea(null); setPinError(p.length > 0 && p.length < 6 ? null : null);
      return;
    }
    if (pinArea?.pincode === p) return;
    const t = setTimeout(() => resolvePincode(p), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pincode]);

  // Drop change from map (drag or click) — reverse-geocode to save address
  const handleMapDropChange = async ({ lat, lng }) => {
    // Optimistic marker update while address loads
    setDrop((prev) => ({ lat, lng, display_name: prev?.display_name || "Locating…" }));
    try {
      const r = await api.get(`/reverse-geocode?lat=${lat}&lng=${lng}`);
      setDrop({ lat, lng, display_name: r.data?.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
    } catch {
      setDrop({ lat, lng, display_name: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
    }
  };

  const confirm = async () => {
    if (!form.name || !form.mobile) return toast.error("Please enter your name and mobile");
    if (form.mobile.length !== 10) return toast.error("Enter a valid 10-digit mobile");
    if (!pickup) return toast.error("Please select a pickup location");
    if (!vehicleType) return toast.error("Please choose a vehicle category");
    if (!pinArea?.pincode) return toast.error("Enter a valid enabled Pickup PIN");
    if (!drop?.id) return toast.error("Please select a Drop Place from the AvSGo common place list");
    if (routeError) return toast.error(routeError);
    if (!routeMeta || !routeMeta.distance_km) return toast.error("Waiting for road distance — please wait a moment");

    setLoading(true);
    try {
      const r = await api.post("/customer/bookings/auto", {
        vehicle_type: vehicleType,
        customer_name: form.name,
        customer_mobile: form.mobile,
        pickup: pickup.display_name,
        drop_location: drop.display_name,
        drop_place_id: drop.id,
        distance_km: routeMeta.distance_km,
        pickup_lat: pickup.lat,
        pickup_lng: pickup.lng,
        pickup_pin: pinArea.pincode,
        max_radius_km: 25,
      });
      setBooking(r.data);
      try {
        localStorage.setItem("avsgo_customer_profile", JSON.stringify({ name: form.name.trim(), mobile: form.mobile }));
        localStorage.setItem("avsgo_customer_pickup_pin", pinArea.pincode);
      } catch {}
      setStep(4);
      toast.success("Booking broadcast to nearby drivers • first valid driver to accept wins");
      if (pushSupported() && pushPermission() !== "denied") {
        subscribeToPush(`customer:${form.mobile}`).catch(() => {});
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Booking failed");
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (step !== 4 || !booking) return;
    const t = setInterval(async () => {
      try {
        const r = await api.get(`/customer/bookings/${booking.id}`);
        setBooking(r.data);
        if (r.data.status === "accepted" && booking.status === "requested") toast.success("Driver accepted your booking!");
        if (r.data.status === "rejected" && booking.status === "requested") toast.error("Driver rejected your booking");
      } catch {}
    }, 2500);
    return () => clearInterval(t);
  }, [step, booking?.id, booking?.status]);

  useEffect(() => {
    if (step !== 4 || !booking || !["accepted","driver_to_pickup","trip_started"].includes(booking.status)) return;
    let dead=false, last=0, ws;
    const poll=async()=>{ try { const r=await api.get(`/customer/bookings/${booking.id}/trip`,{params:{mobile:booking.customer_mobile}}); if(!dead) setTripState(r.data); } catch {} };
    poll();
    const t=setInterval(poll,5000);
    try {
      ws = new WebSocket(wsUrl("/api/ws/customer", { booking_id: booking.id, mobile: booking.customer_mobile }));
      ws.onmessage = (event) => {
        try {
          const msg=JSON.parse(event.data);
          if (msg.type === "driver_location") setTripState(prev => prev ? ({...prev, driver_location: msg.data}) : prev);
          else if (msg.type === "customer_location") setTripState(prev => prev ? ({...prev, customer_location: msg.data}) : prev);
          else if (["booking_updated","trip_updated","payment_updated"].includes(msg.type)) poll();
        } catch {}
      };
    } catch {}
    const stop=watchPosition((coords)=>{ if(Date.now()-last<3000)return; last=Date.now(); api.post('/customer/location',{customer_mobile:booking.customer_mobile,...coords}).catch(()=>{}); },()=>{});
    return()=>{dead=true;clearInterval(t);try{ws?.close();}catch{};stop&&stop();};
  }, [step, booking?.id, booking?.status]);

  useEffect(()=>{
    if(!tripState) return;
    const stage=tripState.trip_stage;
    const from=stage==='in_trip'?tripState.pickup:tripState.driver_location;
    const to=stage==='in_trip'?tripState.drop:(tripState.customer_location||tripState.pickup);
    if(!from?.lat || !to?.lat) return;
    api.post('/route',{pickup_lat:from.lat,pickup_lng:from.lng,drop_lat:to.lat,drop_lng:to.lng}).then(r=>setTripGeometry(r.data.geometry)).catch(()=>{});
  }, [tripState?.trip_stage,tripState?.driver_location?.lat,tripState?.driver_location?.lng,tripState?.customer_location?.lat,tripState?.customer_location?.lng]);


  if (!onboardingDone) {
    return <div className="mobile-shell min-h-screen bg-white p-6">
      <div className="pt-8">
        <div className="h-14 w-14 rounded-2xl bg-emerald-100 flex items-center justify-center"><Hash className="h-7 w-7 text-emerald-600"/></div>
        <h1 className="font-display text-3xl font-bold mt-4">Welcome to AvSGo</h1>
        <p className="text-gray-500 mt-1">First visit: check your Pickup PIN and save your customer details.</p>
      </div>
      <div className="mt-7 space-y-3">
        <label className="text-sm font-semibold">Pickup PIN</label>
        <input className="field" inputMode="numeric" maxLength="6" placeholder="6-digit Pickup PIN" value={pincode} onChange={e=>setPincode(e.target.value.replace(/\D/g,"").slice(0,6))}/>
        {pinBusy && <div className="text-sm text-gray-500">Checking service availability…</div>}
        {pinArea?.pincode===pincode && <div className="rounded-xl bg-emerald-50 text-emerald-700 p-3 text-sm font-semibold">✓ Service Available — {pinArea.display_name}</div>}
        {pinError && <div className="rounded-xl bg-rose-50 text-rose-700 p-3 text-sm">{pinError}</div>}
        <label className="text-sm font-semibold block pt-2">Name</label>
        <input className="field" placeholder="Your name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/>
        <label className="text-sm font-semibold block pt-2">Mobile Number</label>
        <input className="field" inputMode="numeric" maxLength="10" placeholder="10-digit mobile number" value={form.mobile} onChange={e=>setForm({...form,mobile:e.target.value.replace(/\D/g,"").slice(0,10)})}/>
        <button className="brand-btn w-full mt-3" disabled={onboardingBusy||pinBusy} onClick={completeOnboarding}>{onboardingBusy?"Saving…":"Continue & Save Customer"}</button>
      </div>
    </div>;
  }
  

  return (
    <div className="mobile-shell pb-24">
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur border-b border-gray-200">
        <div className="flex items-center gap-3 p-4">
          <button
            data-testid="customer-back-btn"


            onClick={() => nav("/")}

            
            
            
            className="h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>

            
            <div className="text-xs uppercase tracking-wider text-gray-500">
              {step === 3 && "Booking details"}
              {step === 4 && "Booking status"}
          </div>
          <div className="font-display font-bold text-lg">
              {step === 3 && "Pickup, Drop & Vehicle"}
              {step === 4 && "Booking status"}
            </div>
          </div>
        </div>
      </div>

      {step === 3 && (
        <div className="p-4 space-y-4">

          {/* Pickup */}
          <div className="space-y-2">
            <LocationSearchBar
              label="Pickup"
              testid="customer-pickup-search"
              icon={<Circle className="h-4 w-4 text-emerald-600" fill="#10b981" />}
              value={pickup}
              onSelect={(loc) => { setPickup(loc); gpsAppliedRef.current = true; }}
              onClear={() => setPickup(null)}
              placeholder="Search pickup — area, village, landmark…"
            />
            <div className="flex items-center gap-2 -my-1">
              <div className="flex-1 border-l-2 border-dashed border-gray-300 ml-5 h-3" />
              <button
                data-testid="customer-use-current-btn"
                onClick={useCurrentAsPickup}
                className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 flex items-center gap-1"
              >
                <LocateFixed className="h-3.5 w-3.5" /> Use my current location
              </button>
            </div>

            {/* PIN gate before Drop */}
            <PinCodeField
              value={pincode}
              onChange={(v) => setPincode(v.replace(/\D/g, "").slice(0, 6))}
              busy={pinBusy}
              error={pinError}
              resolved={pinArea}
            />

            {/* Drop — Google Maps style: pressable field opens fullscreen overlay */}
            <button
              data-testid="customer-drop-search-btn"
              onClick={() => pinArea && setDropOverlayOpen(true)}
              disabled={!pinArea}
              className={
                "w-full flex items-center gap-3 rounded-xl border bg-white px-3 py-2.5 text-left transition " +
                (pinArea ? "border-gray-200 hover:border-rose-400 active:scale-[0.997]" : "border-gray-200 opacity-60")
              }
            >
              <Flag className="h-4 w-4 text-rose-600 shrink-0" fill="#e11d48" />
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">
                  {pinArea ? `Search Drop Location (PIN ${pinArea.pincode})` : "Search Drop Location"}
                </div>
                <div className={"text-sm truncate " + (drop ? "font-semibold text-gray-800" : "text-gray-400")}>
                  {drop?.display_name || (pinArea ? "Type any letter — village, school, market, road…" : "Enter a valid PIN code above to enable")}
                </div>
              </div>
              {drop ? (
                <span
                  data-testid="customer-drop-clear-btn"
                  role="button"
                  tabIndex={0}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => { e.stopPropagation(); setDrop(null); }}
                  className="h-6 w-6 rounded-full bg-gray-100 hover:bg-gray-200 flex items-center justify-center shrink-0"
                >
                  <X className="h-3.5 w-3.5 text-gray-600" />
                </span>
              ) : (
                <ChevronRight className="h-5 w-5 text-gray-400 shrink-0" />
              )}
            </button>
          </div>

          {/* Map */}
          <div className="relative">
            <BookingMap
              pickup={pickup}
              drop={drop}
              geometry={routeMeta?.geometry}
              userLocation={userLocation}
              pinArea={null}
              recenterKey={recenterKey}
              onDropChange={handleMapDropChange}
              height="h-72"
            />
            <button
              data-testid="customer-map-recenter-btn"
              onClick={recenter}
              className="absolute right-3 top-3 h-11 w-11 rounded-full bg-white shadow-md border border-gray-200 flex items-center justify-center active:scale-95 transition"
              aria-label="Recenter to my location"
            >
              <LocateFixed className="h-5 w-5 text-emerald-700" />
            </button>
            {pinArea && !drop && (
              <div className="absolute left-3 right-3 bottom-3 rounded-xl bg-white/95 backdrop-blur border border-amber-200 shadow-md px-3 py-2 text-[11px] font-semibold text-amber-800" data-testid="drop-hint">
                Search and select an AvSGo Drop Place added by Admin/Manager
              </div>
            )}
          </div>

          {/* Distance / ETA */}
          <div className="card !py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RouteIcon className="h-5 w-5 text-emerald-700" />
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Distance</div>
                  {routeCalculating ? (
                    <div className="font-display font-bold text-base flex items-center gap-2" data-testid="customer-route-calculating">
                      <Loader2 className="h-4 w-4 animate-spin" /> Calculating…
                    </div>
                  ) : routeError ? (
                    <div className="text-sm font-semibold text-rose-700" data-testid="customer-route-error">{routeError}</div>
                  ) : routeMeta?.distance_km ? (
                    <div className="font-display font-bold text-lg text-emerald-700" data-testid="customer-route-distance">
                      {routeMeta.distance_km} km
                    </div>
                  ) : (
                    <div className="text-sm text-gray-500">Select pickup + drop</div>
                  )}
                </div>
              </div>
              {routeMeta?.duration_min && (
                <div className="text-right">
                  <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">ETA</div>
                  <div className="font-display font-bold text-lg">~{Math.round(routeMeta.duration_min)} min</div>
                </div>
              )}
            </div>
          </div>

          {/* Vehicle Category — shown only after Pickup and Drop fields */}
          <div className="space-y-3">
            <h3 className="font-display font-bold text-lg">Choose Vehicle Category</h3>

            {categoriesLoading && (
              <div className="text-center text-gray-500 py-3">
                Loading vehicle categories...
              </div>
            )}

            {!categoriesLoading && vehicleCategories.length === 0 && (
              <div className="card text-center text-gray-500">
                No vehicle categories available.
              </div>
            )}

            {!categoriesLoading && vehicleCategories.length > 0 && (
              <div className="grid grid-cols-2 gap-3">
                {vehicleCategories.map((category) => {
                  const type = category.name;
                  const meta = VEHICLE_META[type];
                  const fare = fares.find((item) => item.vehicle_type === type);

                  return (
                    <button
                      key={category.id || type}
                      type="button"
                      data-testid={`customer-vehicle-type-${type.replace(/\\s+/g, "-").toLowerCase()}`}
                      onClick={() => pickType(type)}
                      className={`rounded-2xl border p-3 text-left transition ${
                        vehicleType === type
                          ? "border-emerald-600 bg-emerald-50"
                          : "border-gray-200 bg-white hover:border-emerald-500"
                      }`}
                    >
                      <img
                        src={meta?.img || VEHICLE_META["Tata Ace"].img}
                        alt={type}
                        className="h-16 w-full rounded-xl object-cover"
                      />
                      <div className="mt-2 font-display font-bold">{type}</div>
                      <div className="text-xs text-gray-500">
                        {category.capacity || meta?.capacity || "Capacity not specified"}
                      </div>
                      {fare && (
                        <div className="mt-1 text-xs font-semibold text-emerald-700">
                          ₹{fare.base_fare} base + ₹{fare.per_km}/km
                        </div>
                      )}
                      {vehicleType === type && (
                        <div className="mt-2 text-xs font-semibold text-emerald-700">
                          ✓ Selected
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Name + Mobile */}
          <div className="space-y-3">
            <Field icon={<User className="h-5 w-5" />} placeholder="Your name" testid="customer-name"
              value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <Field icon={<Phone className="h-5 w-5" />} placeholder="10-digit mobile" testid="customer-mobile"
              value={form.mobile} onChange={(v) => setForm({ ...form, mobile: v.replace(/\D/g, "").slice(0, 10) })}
              inputMode="numeric" />
          </div>

          {/* Fare */}
          <div className="card bg-emerald-50 border-emerald-200">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider text-emerald-800">Estimated Fare</div>
                <div className="font-display font-bold text-3xl text-emerald-700 flex items-center" data-testid="customer-est-fare">
                  <IndianRupee className="h-6 w-6" />
                  {routeMeta?.distance_km ? estFare : "—"}
                </div>
              </div>
              {fareCfg && (
                <div className="text-xs text-emerald-900 text-right space-y-0.5">
                  <div>Vehicle: <b>{vehicleType}</b></div>
                  <div>Base fare: ₹{fareCfg.base_fare}</div>
                  <div>Per-km rate: ₹{fareCfg.per_km}/km</div>
                  <div>Distance: {routeMeta?.distance_km || "—"} km</div>
                </div>
              )}
            </div>
          </div>

          <button
            data-testid="customer-confirm-btn"
            onClick={confirm}
            disabled={loading || !pickup || !pinArea || !drop || !vehicleType || !routeMeta?.distance_km || routeCalculating}
            className="brand-btn w-full disabled:opacity-60"
          >
            {loading ? "Sending…" : "Confirm booking request"}
          </button>
        </div>
      )}

      <DropSearchOverlay
        open={dropOverlayOpen}
        onClose={() => setDropOverlayOpen(false)}
        onSelect={(loc) => { setDrop(loc); setDropOverlayOpen(false); }}
        pinArea={pinArea}
        pickup={pickup}
      />

      {step === 4 && booking && (
        <div className="p-5 space-y-4">
          <PushEnableBanner subscriberKey={`customer:${booking.customer_mobile}`} />
          {booking.status === "requested" && (
            <div className="card text-center">
              <Clock className="h-14 w-14 text-amber-500 mx-auto animate-pulse" />
              <h2 className="font-display text-xl font-bold mt-3">Waiting for driver…</h2>
              <p className="text-gray-500 text-sm mt-1">We are notifying the vehicle owner.</p>
              <div className="mt-2 text-xs text-gray-400">Booking ID: {booking.id.slice(0, 8)}</div>
            </div>
          )}
          {["accepted","driver_to_pickup","trip_started"].includes(booking.status) && (
            <div className="card border-emerald-500 border-2">
              <CheckCircle2 className="h-14 w-14 text-emerald-600 mx-auto" />
              <h2 className="font-display text-xl font-bold mt-3 text-center">Driver accepted!</h2>
              <p className="text-center text-gray-500 text-sm mt-1">Call the driver to coordinate pickup.</p>
              {booking.driver_distance_m != null && (
                <div className="text-center text-xs text-emerald-700 font-semibold mt-1" data-testid="customer-driver-distance">
                  Driver was ~{(booking.driver_distance_m / 1000).toFixed(2)} km away
                </div>
              )}
              <div className="mt-5 p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-center">
                <div className="text-xs uppercase tracking-wider text-emerald-800">Driver Mobile</div>
                <div className="font-display font-bold text-2xl text-emerald-800 mt-1" data-testid="customer-driver-mobile">
                  {booking.driver_mobile}
                </div>
              </div>
              <a href={`tel:${booking.driver_mobile}`} data-testid="customer-call-driver-btn" className="brand-btn w-full mt-4">
                <PhoneCall className="h-5 w-5 mr-2" /> Call driver
              </a>
              {tripState && <div className="mt-4"><LiveTripMap pickup={tripState.pickup?.lat!=null?{lat:tripState.pickup.lat,lng:tripState.pickup.lng}:null} drop={tripState.drop?.lat!=null?{lat:tripState.drop.lat,lng:tripState.drop.lng}:null} driverLocation={tripState.driver_location} customerLocation={tripState.customer_location} geometry={tripGeometry} stage={tripState.trip_stage}/></div>}
              {tripState?.trip_stage === "at_pickup" && tripState?.status !== "completed" && <button data-testid="customer-start-trip-btn" className="brand-btn w-full mt-3" onClick={async()=>{ try { const r=await api.post(`/customer/bookings/${booking.id}/start-trip`,null,{params:{mobile:booking.customer_mobile}}); setBooking(r.data); toast.success("Trip started"); } catch(e){ toast.error(e.response?.data?.detail||"Driver has not reached pickup yet"); } }}>▶️ Start Trip</button>}
            </div>
          )}
          {booking.status === "rejected" && (
            <div className="card text-center border-rose-300">
              <XCircle className="h-14 w-14 text-rose-500 mx-auto" />
              <h2 className="font-display text-xl font-bold mt-3">Booking rejected</h2>
              <p className="text-gray-500 text-sm mt-1">Please choose another vehicle.</p>
              <button className="brand-btn-outline mt-4" onClick={() => { setBooking(null); setVehicleType(null); setStep(3); }}>Choose another</button>
            </div>
          )}
          {booking.status === "completed" && (
            <div className="card text-center">
              <CheckCircle2 className="h-14 w-14 text-emerald-600 mx-auto" />
              <h2 className="font-display text-xl font-bold mt-3">Trip completed</h2>
              <p className="text-gray-500 text-sm">Thanks for using AvSGo!</p>
            </div>
          )}
          <div className="card text-sm space-y-1">
            <div className="flex justify-between"><span className="text-gray-500">Vehicle</span><span className="font-semibold">{booking.vehicle_type}{booking.plate_no ? ` • ${booking.plate_no}` : ""}</span></div>
            <div className="flex justify-between gap-2"><span className="text-gray-500 shrink-0">Pickup</span><span className="font-semibold text-right line-clamp-2">{booking.pickup}</span></div>
            <div className="flex justify-between gap-2"><span className="text-gray-500 shrink-0">Drop</span><span className="font-semibold text-right line-clamp-2">{booking.drop_location}</span></div>
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
  const ok = !!resolved && resolved.pincode === value;
  return (
    <div className="space-y-1">
      <div
        className={
          "flex items-center gap-3 rounded-xl border bg-white px-3 py-2.5 transition " +
          (ok ? "border-emerald-500" : error ? "border-rose-400" : "border-gray-200 focus-within:border-amber-500")
        }
      >
        <Hash className="h-4 w-4 text-amber-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Enter Drop Area PIN Code</div>
          <input
            data-testid="customer-pincode-input"
            className="w-full bg-transparent outline-none text-sm font-semibold text-gray-800 placeholder-gray-400"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="6-digit PIN e.g. 784161"
            inputMode="numeric"
            maxLength={6}
            autoComplete="postal-code"
          />
        </div>
        {busy ? (
          <Loader2 className="h-4 w-4 text-amber-600 animate-spin shrink-0" />
        ) : ok ? (
          <CheckCircle className="h-5 w-5 text-emerald-600 shrink-0" data-testid="customer-pincode-ok" />
        ) : null}
      </div>
      {error && (
        <div className="text-xs font-semibold text-rose-700 px-1" data-testid="customer-pincode-error">{error}</div>
      )}
      {ok && (
        <div className="text-[11px] text-emerald-800 font-semibold px-1 line-clamp-1" data-testid="customer-pincode-area">
          Area: {resolved.display_name}
        </div>
      )}
    </div>
  );
}

function Field({ icon, testid, value, onChange, ...rest }) {
  return (
    <div className="relative">
      <div className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">{icon}</div>
      <input data-testid={testid} className="field pl-14" value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
    </div>
  );
}

function PushEnableBanner({ subscriberKey }) {
  const [state, setState] = useState(pushPermission());
  if (!pushSupported() || state === "granted") return null;
  const enable = async () => {
    const r = await subscribeToPush(subscriberKey);
    setState(pushPermission());
    if (r.ok) toast.success("You'll get push updates for this booking");
    else if (r.reason === "denied") toast.error("Notifications blocked in browser settings");
  };
  return (
    <button
      data-testid="customer-enable-push-btn"
      onClick={enable}
      className="w-full flex items-center gap-3 p-3 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm font-semibold hover:bg-emerald-100"
    >
      <Bell className="h-5 w-5" /> Enable push notifications for this booking
    </button>
  );
}
