import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LogOut, LayoutDashboard, Car, Users, Package, Settings2, MapPin,
  CheckCircle2, XCircle, IndianRupee, Bell, TrendingUp, Send, BadgeCheck, Wallet,
} from "lucide-react";
import { toast } from "sonner";
import api, { fileUrl } from "@/lib/api";
import { subscribeToPush, pushSupported, pushPermission } from "@/lib/push";
import NotificationBell from "@/components/NotificationBell";
import ManagerAdminView from "@/pages/ManagerAdminView";

const VEHICLE_TYPES = ["E-Rickshaw", "Tata Ace", "Tempo", "Tractor"];

export default function AdminDashboard() {
  const nav = useNavigate();
  const [tab, setTab] = useState("dashboard");
  const [stats, setStats] = useState(null);
  const [vehicles, setVehicles] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [fares, setFares] = useState([]);
  const [payments, setPayments] = useState([]);

  const hdrs = { headers: { "x-role": "admin" } };

  const load = async () => {
    try {
      const [s, v, d, b, f, p] = await Promise.all([
        api.get("/admin/stats", hdrs),
        api.get("/admin/vehicles", hdrs),
        api.get("/admin/drivers", hdrs),
        api.get("/admin/bookings", hdrs),
        api.get("/fare-settings"),
        api.get("/admin/commission-payments", hdrs),
      ]);
      setStats(s.data);
      setVehicles(v.data);
      setDrivers(d.data);
      setBookings(b.data);
      setFares(f.data);
      setPayments(p.data);
    } catch (e) {
      if (e.response?.status === 401) logout();
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    if (pushSupported() && pushPermission() === "granted") {
      subscribeToPush("admin", { role: "admin" }).catch(() => {});
    }
    return () => clearInterval(t);
  }, []);

  const logout = () => {
    localStorage.removeItem("avsgo_admin_token");
    nav("/");
  };

  const approve = async (id, action) => {
    try {
      await api.patch(`/admin/vehicles/${id}`, { action }, hdrs);
      toast.success(`Vehicle ${action}d`);
      load();
    } catch {
      toast.error("Action failed");
    }
  };

  const setAvailability = async (id, available) => {
    try {
      await api.patch(`/admin/vehicles/${id}/availability`, { available }, hdrs);
      toast.success(available ? "Vehicle set Available" : "Vehicle hidden from customers");
      load();
    } catch {
      toast.error("Failed to update availability");
    }
  };

  const notify = async (driver_id) => {
    try {
      const r = await api.post("/admin/notify-driver", { driver_id }, hdrs);
      toast.success(`Reminder sent • ₹${r.data.amount}`);
      load();
    } catch {
      toast.error("Failed to notify");
    }
  };

  const settle = async (driver_id, driver_name, amount) => {
    if (!window.confirm(`Mark ₹${amount} commission for ${driver_name} as PAID?\nThis clears their Commission Owed to ₹0.`)) return;
    try {
      const r = await api.post(`/admin/drivers/${driver_id}/settle-commission`, {}, hdrs);
      toast.success(`Marked ₹${r.data.amount} (${r.data.trips} trip${r.data.trips !== 1 ? "s" : ""}) as paid`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to settle");
    }
  };

  const reviewPayment = async (id, action) => {
    const note = action === "reject" ? (window.prompt("Reason (optional):") || "") : "";
    try {
      const r = await api.patch(`/admin/commission-payments/${id}`, { action, note }, hdrs);
      if (action === "approve") {
        toast.success(`Approved • ₹${r.data.applied_amount} applied to ${r.data.applied_bookings.length} trip(s)`);
      } else {
        toast.success("Payment rejected");
      }
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Review failed");
    }
  };

  const saveFare = async (vt, values) => {
    try {
      await api.put(`/admin/fare-settings/${vt}`, values, hdrs);
      toast.success("Fare updated");
      load();
    } catch {
      toast.error("Failed to save");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <div className="sticky top-0 z-30 bg-white border-b border-gray-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-emerald-600 flex items-center justify-center">
              <Package className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="font-display font-bold">AvSGo Admin</div>
              <div className="text-xs text-gray-500">System Owner Panel</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell role="admin" />
            <button data-testid="admin-logout-btn" onClick={logout} className="h-10 px-3 rounded-lg hover:bg-gray-100 flex items-center gap-2 text-sm">
              <LogOut className="h-4 w-4" /> Logout
            </button>
          </div>
        </div>
      </div>

      <AdminPushBanner />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 grid md:grid-cols-[220px_1fr] gap-6">
        {/* Sidebar */}
        <aside className="md:sticky md:top-20 h-fit">
          <div className="flex md:flex-col gap-1 overflow-x-auto pb-2 md:pb-0">
            {[
              ["dashboard", "Dashboard", LayoutDashboard],
              ["vehicles", "Vehicles", Car],
              ["drivers", "Drivers", Users],
              ["bookings", "Bookings", Package],
              ["payments", "Payments", Wallet],
              ["service_areas", "Service Areas", MapPin],
              ["drop_places", "Drop Places", MapPin],
              ["fares", "Fare Settings", Settings2],
              ["managers", "Managers", Users],
              ["manager_payouts", "Manager Payouts", IndianRupee],
              ["payment_settings", "Payment Settings", Wallet],
            ].map(([k, label, Icon]) => (
              <button
                key={k}
                data-testid={`admin-tab-${k}`}
                onClick={() => setTab(k)}
                className={`flex items-center gap-2 h-11 px-3 rounded-xl text-sm font-semibold whitespace-nowrap ${
                  tab === k ? "bg-emerald-600 text-white" : "text-gray-700 hover:bg-white"
                }`}
              >
                <Icon className="h-4 w-4" /> {label}
                {k === "vehicles" && stats?.pending_vehicles > 0 && (
                  <span className={`ml-auto chip ${tab === k ? "bg-white/25 text-white" : "bg-rose-100 text-rose-700"} px-2`}>
                    {stats.pending_vehicles}
                  </span>
                )}
                {k === "payments" && payments.filter((p) => p.status === "pending").length > 0 && (
                  <span className={`ml-auto chip ${tab === k ? "bg-white/25 text-white" : "bg-amber-100 text-amber-700"} px-2`}>
                    {payments.filter((p) => p.status === "pending").length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </aside>

        {/* Main */}
        <main className="space-y-6">
          {tab === "dashboard" && <DashboardView stats={stats} bookings={bookings} />}
          {tab === "vehicles" && <VehiclesView vehicles={vehicles} onAction={approve} onAvailability={setAvailability} />}
          {tab === "drivers" && <DriversView drivers={drivers} onNotify={notify} onSettle={settle} />}
          {tab === "bookings" && <BookingsView bookings={bookings} />}
          {tab === "payments" && <PaymentsView payments={payments} onReview={reviewPayment} />}
          {tab === "service_areas" && <ServiceAreasView />}
          {tab === "drop_places" && <AdminDropPlacesView />}
          {tab === "fares" && <FaresView fares={fares} onSave={saveFare} />}
          {tab === "managers" && <ManagerAdminView />}
          {tab === "manager_payouts" && <ManagerPayoutsView />}
          {tab === "payment_settings" && <AdminPaymentSettingsView />}
        </main>
      </div>
    </div>
  );
}


function AdminPaymentSettingsView(){
  const [s,setS]=useState({upi_id:"",qr_file_id:null,active:true});
  const hdrs={headers:{"x-role":"admin"}};
  const load=async()=>{try{setS((await api.get("/admin/payment-settings",hdrs)).data)}catch(e){toast.error(e.response?.data?.detail||"Failed to load payment settings")}};
  useEffect(()=>{load()},[]);
  const upload=async(e)=>{const file=e.target.files?.[0];if(!file)return;const fd=new FormData();fd.append("file",file);try{const r=await api.post("/upload",fd,hdrs);setS(x=>({...x,qr_file_id:r.data.id}));toast.success("QR uploaded")}catch(err){toast.error(err.response?.data?.detail||"QR upload failed")}};
  const save=async()=>{try{setS((await api.put("/admin/payment-settings",{upi_id:s.upi_id,qr_file_id:s.qr_file_id||null,active:true},hdrs)).data);toast.success("Admin UPI/QR saved")}catch(e){toast.error(e.response?.data?.detail||"Save failed")}};
  return <div className="space-y-4"><div><h1 className="font-display text-3xl font-bold">Payment Settings</h1><p className="text-gray-500 text-sm">Admin controls the UPI ID and QR shown to drivers for commission settlement.</p></div><div className="card space-y-3"><input className="field" placeholder="Admin UPI ID" value={s.upi_id||""} onChange={e=>setS({...s,upi_id:e.target.value})}/><input className="field" type="file" accept="image/png,image/jpeg,image/webp" onChange={upload}/>{s.qr_file_id&&<img src={fileUrl(s.qr_file_id)} className="h-48 w-48 object-contain border rounded-xl" alt="Admin UPI QR"/>}<button className="brand-btn" onClick={save}>Save Admin UPI / QR</button></div></div>
}

function KpiCard({ icon: Icon, label, value, tone = "emerald" }) {  const tones = {
    emerald: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    blue: "bg-blue-50 text-blue-700",
    slate: "bg-slate-100 text-slate-700",
  };
  return (
    <div className="card">
      <div className="flex items-center gap-3">
        <div className={`h-11 w-11 rounded-xl flex items-center justify-center ${tones[tone]}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
          <div className="font-display font-bold text-2xl">{value}</div>
        </div>
      </div>
    </div>
  );
}

function DashboardView({ stats, bookings }) {
  if (!stats) return <div className="text-gray-500">Loading…</div>;
  return (
    <>
      <div>
        <h1 className="font-display text-3xl font-bold">Overview</h1>
        <p className="text-gray-500 text-sm mt-1">Live snapshot of AvSGo operations.</p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon={Users} label="Drivers" value={stats.drivers} />
        <KpiCard icon={Car} label="Pending Vehicles" value={stats.pending_vehicles} tone="amber" />
        <KpiCard icon={Package} label="Bookings" value={stats.total_bookings} tone="blue" />
        <KpiCard icon={TrendingUp} label="Completed" value={stats.completed_trips} tone="slate" />
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="card">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-xl bg-emerald-600 flex items-center justify-center">
              <IndianRupee className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-gray-500">Total Revenue (completed)</div>
              <div className="font-display font-bold text-3xl text-emerald-700">₹{stats.revenue}</div>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="flex items-center gap-3">
            <div className="h-11 w-11 rounded-xl bg-blue-600 flex items-center justify-center">
              <IndianRupee className="h-5 w-5 text-white" />
            </div>
            <div>
              <div className="text-xs uppercase tracking-wider text-gray-500">Commission Earned</div>
              <div className="font-display font-bold text-3xl text-blue-700">₹{stats.commission_earned}</div>
              <div className="text-xs text-gray-500">Payable to UPI: <b>{stats.upi}</b></div>
            </div>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="font-display font-bold text-lg">Recent bookings</div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 text-xs uppercase">
                <th className="py-2">Customer</th><th>Vehicle</th><th>From → To</th><th>Fare</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {bookings.slice(0, 8).map((b) => (
                <tr key={b.id} className="border-t border-gray-100">
                  <td className="py-2">{b.customer_name}<div className="text-xs text-gray-400">{b.customer_mobile}</div></td>
                  <td>{b.vehicle_type}<div className="text-xs text-gray-400">{b.plate_no}</div></td>
                  <td className="text-xs">{b.pickup} → {b.drop_location}</td>
                  <td className="font-semibold">₹{b.fare}</td>
                  <td><StatusChip status={b.status} /></td>
                </tr>
              ))}
              {bookings.length === 0 && <tr><td colSpan="5" className="text-center py-6 text-gray-400">No bookings yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function VehiclesView({ vehicles, onAction, onAvailability }) {
  const [filter, setFilter] = useState("pending");
  const filtered = vehicles.filter((v) => (filter === "all" ? true : v.status === filter));
  return (
    <>
      <h1 className="font-display text-3xl font-bold">Vehicles</h1>
      <div className="flex gap-2">
        {["pending", "approved", "rejected", "all"].map((f) => (
          <button
            key={f}
            data-testid={`admin-vehicle-filter-${f}`}
            onClick={() => setFilter(f)}
            className={`h-9 px-4 rounded-lg text-sm font-semibold capitalize ${
              filter === f ? "bg-emerald-600 text-white" : "bg-white border border-gray-200"
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        {filtered.length === 0 && <div className="text-gray-500 col-span-full">No vehicles.</div>}
        {filtered.map((v) => {
          const isAvailable = v.available !== false; // undefined = available
          return (
            <div key={v.id} className="card" data-testid={`admin-vehicle-${v.id}`}>
              <div className="flex gap-3">
                {v.vehicle_photo_id ? (
                  <img src={fileUrl(v.vehicle_photo_id)} className="h-24 w-24 rounded-xl object-cover" alt="" />
                ) : (
                  <div className="h-24 w-24 rounded-xl bg-gray-100 flex items-center justify-center">
                    <Car className="h-8 w-8 text-gray-400" />
                  </div>
                )}
                <div className="flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-display font-bold">{v.vehicle_type}</div>
                    <div className="flex items-center gap-1.5">
                      <StatusChip status={v.status} />
                      {v.status === "approved" && (
                        <span
                          data-testid={`avail-chip-${v.id}`}
                          className={`chip ${isAvailable ? "bg-emerald-100 text-emerald-800" : "bg-gray-200 text-gray-700"}`}
                        >
                          {isAvailable ? "Available" : "Hidden"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-sm text-gray-500">{v.plate_no} • {v.capacity}</div>
                  {v.driver && (
                    <div className="text-xs text-gray-500 mt-1">
                      Driver: <b>{v.driver.name}</b> • {v.driver.mobile}
                    </div>
                  )}
                  {v.rc_photo_id && (
                    <a href={fileUrl(v.rc_photo_id)} target="_blank" rel="noreferrer" className="text-xs text-emerald-700 font-semibold mt-1 inline-block">
                      View RC photo →
                    </a>
                  )}
                </div>
              </div>
              {v.status === "pending" && (
                <div className="mt-3 flex gap-2">
                  <button data-testid={`approve-vehicle-${v.id}`} onClick={() => onAction(v.id, "approve")} className="brand-btn flex-1 h-11">
                    <CheckCircle2 className="h-5 w-5 mr-1" /> Approve
                  </button>
                  <button data-testid={`reject-vehicle-${v.id}`} onClick={() => onAction(v.id, "reject")} className="h-11 flex-1 rounded-xl border-2 border-rose-500 text-rose-600 font-semibold hover:bg-rose-50">
                    <XCircle className="h-5 w-5 mr-1 inline" /> Reject
                  </button>
                </div>
              )}
              {v.status === "approved" && (
                <div className="mt-3 flex items-center justify-between rounded-xl border border-gray-200 p-3">
                  <div className="text-sm">
                    <div className="font-semibold">Customer availability</div>
                    <div className="text-xs text-gray-500">
                      {isAvailable
                        ? "Visible & bookable in the customer panel"
                        : "Hidden from customers — cannot be selected"}
                    </div>
                  </div>
                  <div className="flex gap-1.5" role="group" aria-label="Availability">
                    <button
                      data-testid={`avail-available-${v.id}`}
                      onClick={() => !isAvailable && onAvailability(v.id, true)}
                      className={`h-9 px-3 rounded-lg text-xs font-semibold transition ${
                        isAvailable ? "bg-emerald-600 text-white" : "bg-white border border-gray-200 text-gray-700 hover:bg-emerald-50"
                      }`}
                      aria-pressed={isAvailable}
                    >
                      Available
                    </button>
                    <button
                      data-testid={`avail-hidden-${v.id}`}
                      onClick={() => isAvailable && onAvailability(v.id, false)}
                      className={`h-9 px-3 rounded-lg text-xs font-semibold transition ${
                        !isAvailable ? "bg-gray-800 text-white" : "bg-white border border-gray-200 text-gray-700 hover:bg-gray-100"
                      }`}
                      aria-pressed={!isAvailable}
                    >
                      Not available
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

function DriversView({ drivers, onNotify, onSettle }) {
  return (
    <>
      <h1 className="font-display text-3xl font-bold">Drivers</h1>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 text-xs uppercase">
              <th className="py-2">Name</th><th>Mobile</th><th>Trips</th><th>Commission Owed</th><th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((d) => {
              const owed = Number(d.commission_owed || 0);
              const hasOwed = owed > 0;
              return (
                <tr key={d.id} className="border-t border-gray-100" data-testid={`admin-driver-${d.id}`}>
                  <td className="py-3 font-semibold">{d.name}</td>
                  <td>{d.mobile}</td>
                  <td>{d.completed_trips}</td>
                  <td data-testid={`driver-commission-${d.id}`} className={`font-display font-bold ${hasOwed ? "text-emerald-700" : "text-gray-400"}`}>
                    ₹{owed}
                  </td>
                  <td>
                    <div className="flex justify-end gap-2 flex-wrap">
                      <button
                        data-testid={`notify-driver-${d.id}`}
                        onClick={() => onNotify(d.id)}
                        disabled={!hasOwed}
                        className="h-9 px-3 rounded-lg bg-amber-500 text-white text-sm font-semibold flex items-center gap-1.5 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Send className="h-4 w-4" /> Remind
                      </button>
                      <button
                        data-testid={`settle-driver-${d.id}`}
                        onClick={() => onSettle(d.id, d.name, owed)}
                        disabled={!hasOwed}
                        className="h-9 px-3 rounded-lg bg-emerald-600 text-white text-sm font-semibold flex items-center gap-1.5 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <BadgeCheck className="h-4 w-4" /> Mark paid
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {drivers.length === 0 && <tr><td colSpan="5" className="text-center py-6 text-gray-400">No drivers</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BookingsView({ bookings }) {
  return (
    <>
      <h1 className="font-display text-3xl font-bold">Bookings & Trips</h1>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 text-xs uppercase">
              <th className="py-2">Customer</th><th>Vehicle</th><th>Route</th><th>KM</th><th>Fare</th><th>Commission</th><th>Status</th><th>Time</th>
            </tr>
          </thead>
          <tbody>
            {bookings.map((b) => (
              <tr key={b.id} className="border-t border-gray-100">
                <td className="py-2">{b.customer_name}<div className="text-xs text-gray-400">{b.customer_mobile}</div></td>
                <td>{b.vehicle_type}<div className="text-xs text-gray-400">{b.plate_no}</div></td>
                <td className="text-xs">{b.pickup} → {b.drop_location}</td>
                <td>{b.distance_km}</td>
                <td className="font-semibold">₹{b.fare}</td>
                <td className="text-blue-700 font-semibold">₹{b.commission}</td>
                <td><StatusChip status={b.status} /></td>
                <td className="text-xs text-gray-400">{new Date(b.created_at).toLocaleString()}</td>
              </tr>
            ))}
            {bookings.length === 0 && <tr><td colSpan="8" className="text-center py-6 text-gray-400">No bookings</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FaresView({ fares, onSave }) {
  return (
    <>
      <h1 className="font-display text-3xl font-bold">Fare & Commission</h1>
      <p className="text-gray-500 text-sm">Set base fare, per-km rate and admin commission % for each vehicle type.</p>
      <div className="grid md:grid-cols-2 gap-3">
        {VEHICLE_TYPES.map((vt) => {
          const f = fares.find((x) => x.vehicle_type === vt);
          return <FareCard key={vt} vt={vt} data={f} onSave={onSave} />;
        })}
      </div>
    </>
  );
}

function FareCard({ vt, data, onSave }) {
  const [values, setValues] = useState({ base_fare: 0, per_km: 0, commission_pct: 0 });
  useEffect(() => {
    if (data) setValues({ base_fare: data.base_fare, per_km: data.per_km, commission_pct: data.commission_pct });
  }, [data]);
  return (
    <div className="card">
      <div className="font-display font-bold text-lg">{vt}</div>
      <div className="mt-3 space-y-2">
        <NumberField label="Base fare (₹)" testid={`fare-base-${vt}`} value={values.base_fare} onChange={(v) => setValues({ ...values, base_fare: v })} />
        <NumberField label="Per KM (₹)" testid={`fare-perkm-${vt}`} value={values.per_km} onChange={(v) => setValues({ ...values, per_km: v })} />
        <NumberField label="Commission %" testid={`fare-commission-${vt}`} value={values.commission_pct} onChange={(v) => setValues({ ...values, commission_pct: v })} />
      </div>
      <button data-testid={`fare-save-${vt}`} onClick={() => onSave(vt, values)} className="brand-btn w-full mt-3">Save</button>
    </div>
  );
}

function NumberField({ label, value, onChange, testid }) {
  return (
    <label className="block">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <input
        data-testid={testid}
        type="number"
        inputMode="decimal"
        className="field"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      />
    </label>
  );
}

function StatusChip({ status }) {
  const map = {
    pending: "bg-amber-100 text-amber-800",
    approved: "bg-emerald-100 text-emerald-800",
    rejected: "bg-rose-100 text-rose-700",
    requested: "bg-amber-100 text-amber-800",
    accepted: "bg-emerald-100 text-emerald-800",
    completed: "bg-blue-100 text-blue-700",
  };
  return <span className={`chip ${map[status] || "bg-gray-100 text-gray-700"}`}>{status}</span>;
}

function AdminPushBanner() {
  const [state, setState] = useState(pushPermission());
  if (!pushSupported() || state === "granted") return null;
  const enable = async () => {
    const r = await subscribeToPush("admin", { role: "admin" });
    setState(pushPermission());
    if (r.ok) toast.success("Push notifications enabled");
    else if (r.reason === "denied") toast.error("Notifications blocked in browser settings");
  };
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-4">
      <button
        data-testid="admin-enable-push-btn"
        onClick={enable}
        className="w-full flex items-center gap-3 p-3 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm font-semibold hover:bg-emerald-100"
      >
        <Bell className="h-5 w-5" /> Enable push notifications for new bookings, drivers & vehicles
      </button>
    </div>
  );
}

function PaymentsView({ payments, onReview }) {
  const [filter, setFilter] = useState("pending");
  const filtered = payments.filter((p) => (filter === "all" ? true : p.status === filter));
  const pendingCount = payments.filter((p) => p.status === "pending").length;
  return (
    <>
      <h1 className="font-display text-3xl font-bold">Commission Payments</h1>
      <p className="text-gray-500 text-sm">
        Verify driver-submitted payments. Approved amounts are deducted from Commission Due.
        {pendingCount > 0 && <span className="text-amber-700 font-semibold"> {pendingCount} pending.</span>}
      </p>
      <div className="flex gap-2">
        {["pending", "approved", "rejected", "all"].map((f) => (
          <button
            key={f}
            data-testid={`admin-payment-filter-${f}`}
            onClick={() => setFilter(f)}
            className={`h-9 px-4 rounded-lg text-sm font-semibold capitalize ${
              filter === f ? "bg-emerald-600 text-white" : "bg-white border border-gray-200"
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 text-xs uppercase">
              <th className="py-2">Driver</th><th>Amount</th><th>UTR</th><th>Submitted</th><th>Status</th><th className="text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => (
              <tr key={p.id} className="border-t border-gray-100" data-testid={`admin-payment-${p.id}`}>
                <td className="py-3">
                  <div className="font-semibold">{p.driver_name}</div>
                  <div className="text-xs text-gray-400">{p.driver_mobile}</div>
                </td>
                <td className="font-display font-bold text-emerald-700">₹{p.amount}</td>
                <td className="text-xs font-mono">{p.utr}</td>
                <td className="text-xs text-gray-400">{new Date(p.submitted_at).toLocaleString()}</td>
                <td><StatusChip status={p.status === "pending" ? "requested" : p.status === "approved" ? "accepted" : "rejected"} /></td>
                <td>
                  {p.status === "pending" ? (
                    <div className="flex justify-end gap-2">
                      <button
                        data-testid={`payment-approve-${p.id}`}
                        onClick={() => onReview(p.id, "approve")}
                        className="h-9 px-3 rounded-lg bg-emerald-600 text-white text-sm font-semibold flex items-center gap-1.5 hover:bg-emerald-700"
                      >
                        <CheckCircle2 className="h-4 w-4" /> Approve
                      </button>
                      <button
                        data-testid={`payment-reject-${p.id}`}
                        onClick={() => onReview(p.id, "reject")}
                        className="h-9 px-3 rounded-lg border-2 border-rose-500 text-rose-600 text-sm font-semibold flex items-center gap-1.5 hover:bg-rose-50"
                      >
                        <XCircle className="h-4 w-4" /> Reject
                      </button>
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400 text-right">
                      {p.status === "approved" && `Applied ₹${p.applied_amount || 0}`}
                      {p.note && <div className="italic">"{p.note}"</div>}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan="6" className="text-center py-6 text-gray-400">No {filter} payments</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

  function ServiceAreasView() {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({
    pickup_pin: "",
    area_name: "",
    latitude: "",
    longitude: "",
    enabled: true,
  });

  const hdrs = { headers: { "x-role": "admin" } };

  const load = async () => {
    try {
      setRows((await api.get("/admin/service-areas", hdrs)).data);
    } catch (e) {
      toast.error(
        e.response?.data?.detail || "Failed to load service areas"
      );
    }
  };

  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    if (!/^\d{6}$/.test(f.pickup_pin) || !f.area_name.trim()) {
      return toast.error("Enter 6-digit Pickup PIN and area name");
    }

    try {
      await api.post(
        "/admin/service-areas",
        {
          ...f,
          latitude: f.latitude ? Number(f.latitude) : null,
          longitude: f.longitude ? Number(f.longitude) : null,
        },
        hdrs
      );

      toast.success("Service area saved");

      setF({
        pickup_pin: "",
        area_name: "",
        latitude: "",
        longitude: "",
        enabled: true,
      });

      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    }
  };

  const toggle = async (r) => {
    try {
      await api.patch(
        `/admin/service-areas/${r.id}`,
        { enabled: !r.enabled },
        hdrs
      );
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Update failed");
    }
  };

  const edit = async (r) => {
    const name = window.prompt("Area name", r.area_name);

    if (!name || name === r.area_name) return;

    try {
      await api.patch(
        `/admin/service-areas/${r.id}`,
        { area_name: name },
        hdrs
      );
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Update failed");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-3xl font-bold">
          Service Areas
        </h1>

        <p className="text-gray-500 text-sm">
          Pickup PIN controls customer service eligibility and manager assignment.
        </p>
      </div>

      <div className="card grid md:grid-cols-5 gap-2">
        <input
          className="field"
          placeholder="Pickup PIN"
          maxLength="6"
          value={f.pickup_pin}
          onChange={(e) =>
            setF({
              ...f,
              pickup_pin: e.target.value.replace(/\D/g, "").slice(0, 6),
            })
          }
        />

        <input
          className="field"
          placeholder="Area Name"
          value={f.area_name}
          onChange={(e) =>
            setF({ ...f, area_name: e.target.value })
          }
        />

        <input
          className="field"
          placeholder="Latitude"
          value={f.latitude}
          onChange={(e) =>
            setF({ ...f, latitude: e.target.value })
          }
        />

        <input
          className="field"
          placeholder="Longitude"
          value={f.longitude}
          onChange={(e) =>
            setF({ ...f, longitude: e.target.value })
          }
        />

        <button className="brand-btn" onClick={add}>
          Add / Save PIN
        </button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-2">PIN</th>
              <th>Area</th>
              <th>Coordinates</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-3 font-semibold">
                  {r.pickup_pin}
                </td>

                <td>{r.area_name}</td>

                <td>
                  {r.latitude ?? "—"}, {r.longitude ?? "—"}
                </td>

                <td>
                  {r.enabled ? "Enabled" : "Disabled"}
                </td>

                <td className="flex gap-2 py-2">
                  <button
                    className="h-9 px-3 rounded-lg bg-gray-100"
                    onClick={() => edit(r)}
                  >
                    Edit
                  </button>

                  <button
                    className="h-9 px-3 rounded-lg bg-gray-100"
                    onClick={() => toggle(r)}
                  >
                    {r.enabled ? "Disable" : "Enable"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!rows.length && (
          <div className="text-gray-500 py-4">
            No service areas yet.
          </div>
        )}
      </div>
    </div>
  );
}

function AdminDropPlacesView() {
  const [rows, setRows] = useState([]);

  const [f, setF] = useState({
    place_name: "",
    latitude: "",
    longitude: "",
    pickup_pin: "",
    enabled: true,
  });

  const hdrs = { headers: { "x-role": "admin" } };

  const load = async () => {
    try {
      setRows((await api.get("/admin/drop-places", hdrs)).data);
    } catch (e) {
      toast.error(
        e.response?.data?.detail || "Failed to load drop places"
      );
    }
  };

  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    if (!f.place_name.trim()) {
      return toast.error("Place name is required");
    }

    try {
      await api.post(
        "/admin/drop-places",
        {
          ...f,
          latitude: Number(f.latitude),
          longitude: Number(f.longitude),
          pickup_pin: f.pickup_pin || null,
        },
        hdrs
      );

      toast.success("Drop Place added");

      setF({
        place_name: "",
        latitude: "",
        longitude: "",
        pickup_pin: "",
        enabled: true,
      });

      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    }
  };

  const toggle = async (r) => {
    try {
      await api.patch(
        `/admin/drop-places/${r.id}`,
        { enabled: !r.enabled },
        hdrs
      );
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Update failed");
    }
  };

  const edit = async (r) => {
    const name = window.prompt("Place name", r.place_name);

    if (!name || name === r.place_name) return;

    try {
      await api.patch(
        `/admin/drop-places/${r.id}`,
        { place_name: name },
        hdrs
      );
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Update failed");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-3xl font-bold">
          Drop Places
        </h1>

        <p className="text-gray-500 text-sm">
          Unlimited common drop places. Drop PIN restriction is not used.
        </p>
      </div>

      <div className="card grid md:grid-cols-5 gap-2">
        <input
          className="field"
          placeholder="Place name"
          value={f.place_name}
          onChange={(e) =>
            setF({ ...f, place_name: e.target.value })
          }
        />

        <input
          className="field"
          placeholder="Latitude"
          value={f.latitude}
          onChange={(e) =>
            setF({ ...f, latitude: e.target.value })
          }
        />

        <input
          className="field"
          placeholder="Longitude"
          value={f.longitude}
          onChange={(e) =>
            setF({ ...f, longitude: e.target.value })
          }
        />

        <input
          className="field"
          placeholder="Pickup PIN (optional)"
          maxLength="6"
          value={f.pickup_pin}
          onChange={(e) =>
            setF({
              ...f,
              pickup_pin: e.target.value
                .replace(/\D/g, "")
                .slice(0, 6),
            })
          }
        />

        <button className="brand-btn" onClick={add}>
          Add Place
        </button>
      </div>

      <div className="card space-y-2">
        {rows.map((r) => (
          <div
            key={r.id}
            className="border rounded-xl p-3 flex items-center justify-between gap-3"
          >
            <div>
              <b>{r.place_name}</b>

              <div className="text-xs text-gray-500">
                {r.enabled ? "Enabled" : "Disabled"} •{" "}
                {r.pickup_pin || "No PIN restriction"} •{" "}
                {r.added_by_type || "admin"}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                className="h-9 px-3 rounded-lg bg-gray-100"
                onClick={() => edit(r)}
              >
                Edit
              </button>

              <button
                className="h-9 px-3 rounded-lg bg-gray-100"
                onClick={() => toggle(r)}
              >
                {r.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          </div>
        ))}

        {!rows.length && (
          <div className="text-gray-500 py-4">
            No Drop Places yet.
          </div>
        )}
      </div>
    </div>
  );
}

function ManagerPayoutsView() {
  const [rows, setRows] = useState([]);
  const [managers, setManagers] = useState([]);

  const [f, setF] = useState({
    manager_id: "",
    amount: "",
    receipt_file_id: "",
    note: "",
  });

  const [managerPayment, setManagerPayment] = useState(null);
  const [managerSummary, setManagerSummary] = useState(null);

  const hdrs = { headers: { "x-role": "admin" } };

  const load = async () => {
    try {
      const [p, m] = await Promise.all([
        api.get("/admin/manager-payouts", hdrs),
        api.get("/admin/managers", hdrs),
      ]);

      setRows(p.data);
      setManagers(m.data);
    } catch (e) {
      toast.error(
        e.response?.data?.detail || "Failed to load payouts"
      );
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selectManager = async (id) => {
    setF((x) => ({ ...x, manager_id: id }));

    if (!id) {
      setManagerPayment(null);
      setManagerSummary(null);
      return;
    }

    try {
      const [ps, sm] = await Promise.all([
        api.get(`/admin/manager-payment-settings/${id}`, hdrs),
        api.get(`/admin/managers/${id}/commission-summary`, hdrs),
      ]);

      setManagerPayment(ps.data);
      setManagerSummary(sm.data);
    } catch (e) {
      setManagerPayment(null);
      toast.error(
        e.response?.data?.detail ||
          "Could not load manager UPI/QR"
      );
    }
  };

  const pay = async () => {
    if (!f.manager_id || Number(f.amount) <= 0) {
      return toast.error(
        "Select manager and enter amount"
      );
    }

    try {
      await api.post(
        "/admin/manager-payouts",
        {
          manager_id: f.manager_id,
          amount: Number(f.amount),
          receipt_file_id: f.receipt_file_id || null,
          note: f.note || null,
        },
        hdrs
      );

      toast.success("Manager payment recorded");

      setF({
        manager_id: "",
        amount: "",
        receipt_file_id: "",
        note: "",
      });

      load();
    } catch (e) {
      toast.error(
        e.response?.data?.detail || "Payment failed"
      );
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-3xl font-bold">
          Manager Payouts
        </h1>

        <p className="text-gray-500 text-sm">
          Admin pays earned manager commission and keeps the receipt/history.
        </p>
      </div>

      <div className="card grid md:grid-cols-4 gap-2">
        <select
          className="field"
          value={f.manager_id}
          onChange={(e) => selectManager(e.target.value)}
        >
          <option value="">Select Manager</option>

          {managers
            .filter((m) => m.active && !m.resigned)
            .map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} • {m.manager_id}
              </option>
            ))}
        </select>

        <input
          className="field"
          type="number"
          min="0"
          step="0.01"
          placeholder="Amount"
          value={f.amount}
          onChange={(e) =>
            setF({ ...f, amount: e.target.value })
          }
        />

        <input
          className="field"
          placeholder="Receipt File ID (optional)"
          value={f.receipt_file_id}
          onChange={(e) =>
            setF({
              ...f,
              receipt_file_id: e.target.value,
            })
          }
        />

        <button className="brand-btn" onClick={pay}>
          Pay Manager
        </button>

        <input
          className="field md:col-span-4"
          placeholder="Note"
          value={f.note}
          onChange={(e) =>
            setF({ ...f, note: e.target.value })
          }
        />

        {managerSummary && (
          <div className="md:col-span-4 border rounded-xl p-3 text-sm">
            <b>
              Payable to Manager: ₹{managerSummary.remaining}
            </b>{" "}
            • Earned ₹{managerSummary.earned} • Paid ₹
            {managerSummary.paid}
          </div>
        )}

        {managerPayment && (
          <div className="md:col-span-4 border rounded-xl p-3 text-sm">
            <b>{managerPayment.manager?.name}</b> • UPI:{" "}
            <b>
              {managerPayment.payment?.upi_id || "Not set"}
            </b>

            {managerPayment.payment?.qr_file_id && (
              <img
                src={fileUrl(
                  managerPayment.payment.qr_file_id
                )}
                className="mt-2 h-32 w-32 object-contain border rounded-lg"
                alt="Manager QR"
              />
            )}
          </div>
        )}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-2">Manager</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Receipt</th>
              <th>Date</th>
            </tr>
          </thead>

          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-3">
                  {r.manager_name}
                </td>

                <td className="font-semibold">
                  ₹{r.amount}
                </td>

                <td>{r.status}</td>

                <td>
                  {r.receipt_file_id || "—"}
                </td>

                <td>
                  {r.paid_at || r.created_at}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {!rows.length && (
          <div className="text-gray-500 py-4">
            No manager payouts yet.
          </div>
        )}
      </div>
    </div>
  );
}
