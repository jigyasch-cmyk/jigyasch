import { Link, useNavigate } from "react-router-dom";
import { useRef, useState } from "react";
import { Package, Car, ChevronRight, Truck, Tractor, Bike, MapPin, Hash, User, Phone, X, CheckCircle2, BriefcaseBusiness, Search, Menu, Bell } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

const HERO = "/avsgo-hero.jpg";

const VEHICLES = [
  { icon: Bike, name: "E-Rickshaw", desc: "Small local loads" },
  { icon: Truck, name: "Tata Ace", desc: "Up to small commercial loads" },
  { icon: Truck, name: "Tempo", desc: "Medium loads" },
  { icon: Tractor, name: "Tractor", desc: "Heavy rural loads" },
];

const FAQS = [
  { q: "What is AvSGo?", a: "AvSGo is a local vehicle booking platform for goods transport using E-rickshaw, Tata Ace, Tempo and Tractor." },
  { q: "How can I book a vehicle?", a: "Tap Book Now or tap the customer area, enter your Pickup PIN once, save your customer details, then use GPS pickup and choose a drop place." },
  { q: "Do I need to enter my Pickup PIN every time?", a: "No. After the first successful customer registration, the Pickup PIN and customer profile are saved on the device for direct access next time." },
  { q: "How do drivers receive bookings?", a: "Approved active online drivers can receive nearby booking requests. Pickup PIN is not a driver dispatch restriction." },
];

export default function Landing() {
  const nav = useNavigate();
  const taps = useRef({ count: 0, timer: null });
  const [serviceOpen, setServiceOpen] = useState(false);
  const [stage, setStage] = useState("pin");
  const [pin, setPin] = useState(localStorage.getItem("avsgo_customer_pickup_pin") || "");
  const [pinArea, setPinArea] = useState(null);
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState("");
  const [form, setForm] = useState(() => {
    try { return JSON.parse(localStorage.getItem("avsgo_customer_profile") || "null") || { name: "", mobile: "" }; } catch { return { name: "", mobile: "" }; }
  });
  const [saving, setSaving] = useState(false);

  const secretAdminTap = () => {
    taps.current.count += 1;
    clearTimeout(taps.current.timer);
    taps.current.timer = setTimeout(() => { taps.current.count = 0; }, 1200);
    if (taps.current.count >= 5) { taps.current.count = 0; nav("/admin/login"); }
  };

  const openCustomer = () => {
    try {
      const profile = JSON.parse(localStorage.getItem("avsgo_customer_profile") || "null");
      const savedPin = localStorage.getItem("avsgo_customer_pickup_pin");
      if (profile?.name && profile?.mobile && /^\d{6}$/.test(savedPin || "")) {
        nav("/customer");
        return;
      }
    } catch {}
    setStage("pin");
    setPin(localStorage.getItem("avsgo_customer_pickup_pin") || "");
    setPinArea(null);
    setPinError("");
    setServiceOpen(true);
  };

  const resolvePin = async (value) => {
    const clean = value.replace(/\D/g, "").slice(0, 6);
    setPin(clean); setPinError(""); setPinArea(null);
    if (clean.length !== 6) return;
    setPinBusy(true);
    try {
      const r = await api.get(`/pincode/${clean}`);
      setPinArea(r.data);
    } catch (e) {
      setPinError(e.response?.data?.detail || "This Pickup PIN is not an enabled AvSGo service area");
    } finally { setPinBusy(false); }
  };

  const continueFromPin = () => {
    if (!pinArea?.pincode || pinArea.pincode !== pin) return toast.error("Enter an enabled 6-digit Pickup PIN");
    setStage("register");
  };

  const saveCustomer = async () => {
    if (!form.name.trim()) return toast.error("Enter your name");
    if (!/^\d{10}$/.test(form.mobile)) return toast.error("Enter a valid 10-digit mobile number");
    if (!pinArea?.pincode || pinArea.pincode !== pin) return toast.error("Please verify Pickup PIN first");
    setSaving(true);
    try {
      await api.post("/customer/register", { name: form.name.trim(), mobile: form.mobile, pickup_pin: pin });
      localStorage.setItem("avsgo_customer_profile", JSON.stringify({ name: form.name.trim(), mobile: form.mobile }));
      localStorage.setItem("avsgo_customer_pickup_pin", pin);
      toast.success("Customer saved • Service available");
      setServiceOpen(false);
      nav("/customer");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Customer registration failed");
    } finally { setSaving(false); }
  };

  const handleCustomerSurfaceClick = (e) => {
    const interactive = e.target.closest("a,button,input,textarea,select,[data-ignore-service-tap]");
    if (!interactive) openCustomer();
  };

  return (
    <div className="mobile-shell relative overflow-hidden bg-white" onClick={handleCustomerSurfaceClick}>
      <div className="relative h-[50vh] min-h-[360px] w-full">
        <img src={HERO} alt="AvSGo goods transport" className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-b from-blue-950/65 via-blue-900/45 to-emerald-950/75" />
        <div className="relative z-10 h-full flex flex-col p-5">
          <div className="flex items-center justify-between gap-3">
            <button type="button" aria-label="Menu" className="h-11 w-11 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center text-white" data-ignore-service-tap>
              <Menu className="h-7 w-7" />
            </button>
            <button type="button" onClick={secretAdminTap} className="flex items-center gap-1 font-display font-bold text-4xl text-white tracking-tight drop-shadow" data-ignore-service-tap>AvS<span className="text-lime-400">G</span><span className="text-lime-400">o</span></button>
            <button type="button" aria-label="Notifications" className="h-11 w-11 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center text-white" data-ignore-service-tap>
              <Bell className="h-6 w-6" />
            </button>
          </div>
          <div className="mt-auto">
            <p className="text-white/90 text-sm font-semibold">Move Goods • Grow Together</p>
            <h1 className="font-display text-white text-4xl font-bold leading-[1.05] mt-2 drop-shadow">Your Load<br/>Our Drive<br/>A Better Tomorrow</h1>
          </div>
        </div>
      </div>

      <div className="relative -mt-5 rounded-t-3xl bg-white p-5 pb-10 space-y-4" data-testid="customer-home-surface">
        <button type="button" onClick={openCustomer} className="w-full text-left" data-testid="customer-service-area-tap">
          <div className="flex items-center gap-3 rounded-2xl border border-gray-200 p-4 shadow-sm">
            <MapPin className="h-7 w-7 text-blue-600" fill="#2563eb" />
            <div className="flex-1"><div className="font-display font-bold text-lg">Pickup Location</div><div className="text-sm text-gray-500">Use my current location</div></div>
            <ChevronRight className="h-5 w-5 text-gray-400" />
          </div>
        </button>
        <button type="button" onClick={openCustomer} className="w-full text-left" data-testid="customer-drop-tap">
          <div className="flex items-center gap-3 rounded-2xl border border-gray-200 p-4 shadow-sm">
            <MapPin className="h-7 w-7 text-red-600" fill="#dc2626" />
            <div className="flex-1"><div className="font-display font-bold text-lg">Drop Location</div><div className="text-sm text-gray-500">Search your destination</div></div>
            <Search className="h-6 w-6 text-gray-700" />
          </div>
        </button>

        <div className="pt-2">
          <div className="font-display text-2xl font-bold">Choose Vehicle</div>
          <div className="grid grid-cols-4 gap-2 mt-3">
            {VEHICLES.map((v) => <button key={v.name} type="button" onClick={openCustomer} className="rounded-2xl border border-gray-200 p-2 text-center bg-white" data-ignore-service-tap><v.icon className="h-10 w-10 mx-auto text-emerald-600"/><div className="text-xs font-bold mt-2">{v.name}</div></button>)}
          </div>
        </div>

        <button type="button" onClick={openCustomer} className="brand-btn w-full text-lg py-4" data-testid="landing-book-now-btn" data-ignore-service-tap>Book Now <ChevronRight className="inline h-5 w-5 ml-1" /></button>

        <Link to="/driver/register" data-testid="landing-driver-btn" data-ignore-service-tap className="flex items-center gap-4 rounded-2xl border border-blue-100 bg-blue-50 p-4">
          <div className="h-14 w-14 rounded-2xl bg-emerald-100 flex items-center justify-center"><Car className="h-7 w-7 text-emerald-600" /></div>
          <div className="flex-1"><div className="font-display font-bold text-lg text-gray-900">Driver</div><div className="text-sm text-gray-500">Join and start earning</div></div>
          <div className="h-11 w-11 rounded-full bg-blue-600 text-white flex items-center justify-center"><ChevronRight /></div>
        </Link>

        <Link to="/manager/login" data-testid="landing-manager-btn" data-ignore-service-tap className="flex items-center gap-4 rounded-2xl border border-amber-100 bg-amber-50 p-4">
          <div className="h-14 w-14 rounded-2xl bg-amber-100 flex items-center justify-center"><BriefcaseBusiness className="h-7 w-7 text-amber-700" /></div>
          <div className="flex-1"><div className="font-display font-bold text-lg text-gray-900">Manager</div><div className="text-sm text-gray-500">Manage your area</div></div>
          <div className="h-11 w-11 rounded-full bg-amber-500 text-white flex items-center justify-center"><ChevronRight /></div>
        </Link>
      </div>

      <section className="px-5 pb-8">
        <h2 className="font-display text-2xl font-bold text-gray-900">Local goods transport across Assam</h2>
        <p className="text-sm text-gray-600 mt-2">Tap any customer area above Book Now to check service availability. Your Pickup PIN is saved once after registration.</p>
        <div className="mt-5 space-y-2">
          {FAQS.map((f) => <details key={f.q} className="rounded-xl border border-gray-200 p-3"><summary className="font-semibold cursor-pointer">{f.q}</summary><p className="text-sm text-gray-600 mt-2">{f.a}</p></details>)}
        </div>
      </section>

      {serviceOpen && <div className="fixed inset-0 z-50 bg-black/45 flex items-end justify-center" data-ignore-service-tap>
        <div className="w-full max-w-md rounded-t-3xl bg-white p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between"><div><div className="text-xs uppercase tracking-wider text-gray-500">Customer</div><h2 className="font-display text-2xl font-bold">{stage === "pin" ? "Service Available" : "Customer Registration"}</h2></div><button onClick={() => setServiceOpen(false)} className="h-10 w-10 rounded-full bg-gray-100 flex items-center justify-center"><X /></button></div>
          {stage === "pin" ? <div className="mt-5 space-y-3">
            <label className="text-sm font-semibold">Enter Pickup PIN</label>
            <div className="relative"><Hash className="absolute left-4 top-1/2 -translate-y-1/2 text-amber-600 h-5 w-5"/><input autoFocus className="field pl-12" inputMode="numeric" maxLength="6" placeholder="6-digit Pickup PIN" value={pin} onChange={e => resolvePin(e.target.value)} /></div>
            {pinBusy && <div className="text-sm text-gray-500">Checking service availability…</div>}
            {pinArea?.pincode === pin && <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-sm font-semibold text-emerald-700"><CheckCircle2 className="inline h-4 w-4 mr-1"/> Service Available — {pinArea.display_name}</div>}
            {pinError && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{pinError}</div>}
            <button className="brand-btn w-full" disabled={!pinArea || pinArea.pincode !== pin || pinBusy} onClick={continueFromPin}>Continue <ChevronRight className="inline h-5 w-5"/></button>
          </div> : <div className="mt-5 space-y-3">
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-sm font-semibold text-emerald-800">Pickup PIN: {pin} • {pinArea?.display_name}</div>
            <div className="relative"><User className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 h-5 w-5"/><input className="field pl-12" placeholder="Your name" value={form.name} onChange={e => setForm({...form,name:e.target.value})}/></div>
            <div className="relative"><Phone className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 h-5 w-5"/><input className="field pl-12" inputMode="numeric" maxLength="10" placeholder="10-digit mobile number" value={form.mobile} onChange={e => setForm({...form,mobile:e.target.value.replace(/\D/g,"").slice(0,10)})}/></div>
            <button className="brand-btn w-full" disabled={saving} onClick={saveCustomer}>{saving ? "Saving…" : "Register & Save Customer"}</button>
          </div>}
        </div>
      </div>}
    </div>
  );
}
