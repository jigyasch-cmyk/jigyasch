import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BriefcaseBusiness, LogOut, Users, Car, MapPin, Package, Wallet, BarChart3, Plus, Power } from "lucide-react";
import { toast } from "sonner";
import api, { fileUrl } from "@/lib/api";

const labels = { customers:"Customers", drivers:"Drivers", vehicles:"Vehicles", drop_places:"Drop Places", bookings:"Bookings", commission:"Commission", payments:"Payments", reports:"Reports" };

export default function ManagerDashboard() {
  const nav = useNavigate();
  const [me,setMe]=useState(null); const [tab,setTab]=useState("overview");
  const [data,setData]=useState({customers:[],drivers:[],vehicles:[],drop_places:[],bookings:[],commission:null,payouts:[]});
  const [paymentSettings,setPaymentSettings]=useState({upi_id:"",qr_file_id:null,active:true});
  const hdrs={headers:{"x-role":"manager"}};
  const load=async()=>{try{const m=await api.get("/manager/me",hdrs);setMe(m.data); const p=m.data.permissions||{}; const req=[];
    if((p.customers||[]).includes("view"))req.push(api.get("/manager/customers",hdrs).then(r=>["customers",r.data]));
    if((p.drivers||[]).includes("view"))req.push(api.get("/manager/drivers",hdrs).then(r=>["drivers",r.data]));
    if((p.vehicles||[]).includes("view"))req.push(api.get("/manager/vehicles",hdrs).then(r=>["vehicles",r.data]));
    if((p.drop_places||[]).some(x=>["view","add","edit"].includes(x)))req.push(api.get("/manager/drop-places",hdrs).then(r=>["drop_places",r.data]));
    if((p.bookings||[]).includes("view"))req.push(api.get("/manager/bookings",hdrs).then(r=>["bookings",r.data]));
    if((p.commission||[]).includes("view"))req.push(api.get("/manager/commission",hdrs).then(r=>["commission",r.data]));
    if((p.payments||[]).includes("view"))req.push(api.get("/manager/payouts",hdrs).then(r=>["payouts",r.data]));
    const rows=await Promise.all(req);setData(x=>{const n={...x};rows.forEach(([k,v])=>n[k]=v);return n});
    if((p.payments||[]).includes("view")){try{const ps=await api.get(`/payment-settings/manager/${m.data.id}`,hdrs);setPaymentSettings(ps.data||{})}catch{}}
  }catch(e){if(e.response?.status===401||e.response?.status===403){localStorage.removeItem("avsgo_manager_token");nav("/manager/login")}else toast.error(e.response?.data?.detail||"Load failed")}};
  useEffect(()=>{load();const t=setInterval(load,10000);return()=>clearInterval(t)},[]);
  const logout=()=>{localStorage.removeItem("avsgo_manager_token");localStorage.removeItem("avsgo_manager_profile");nav("/")};
  if(!me)return <div className="mobile-shell p-6">Loading…</div>;
  const can=(area,action)=>((me.permissions||{})[area]||[]).includes(action);
  const navItems=[
    ["overview","Overview",BriefcaseBusiness,true],
    ["customers","Customers",Users,can("customers","view")],
    ["drivers","Drivers",Users,can("drivers","view")],
    ["vehicles","Vehicles",Car,can("vehicles","view")],
    ["drop_places","Drop Places",MapPin,can("drop_places","view")||can("drop_places","add")||can("drop_places","edit")],
    ["bookings","Bookings",Package,can("bookings","view")],
    ["commission","Commission",Wallet,can("commission","view")],
    ["payments","Payments",Wallet,can("payments","view")],
    ["reports","Reports",BarChart3,can("reports","view")],
  ];
  return <div className="min-h-screen bg-gray-50"><div className="sticky top-0 z-30 bg-white border-b"><div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between"><div className="flex items-center gap-3"><div className="h-9 w-9 rounded-xl bg-blue-600 flex items-center justify-center"><BriefcaseBusiness className="h-5 w-5 text-white"/></div><div><b>AvSGo Manager</b><div className="text-xs text-gray-500">{me.name} • {me.manager_id}</div></div></div><button onClick={logout} className="h-10 px-3 rounded-lg hover:bg-gray-100 flex gap-2 items-center text-sm"><LogOut className="h-4 w-4"/> Logout</button></div></div>
  <div className="max-w-6xl mx-auto px-4 py-6 grid md:grid-cols-[220px_1fr] gap-6"><aside><div className="flex md:flex-col gap-1 overflow-x-auto">{navItems.filter(x=>x[3]).map(([k,l,I])=><button key={k} onClick={()=>setTab(k)} className={`flex items-center gap-2 h-11 px-3 rounded-xl text-sm font-semibold whitespace-nowrap ${tab===k?"bg-blue-600 text-white":"hover:bg-white"}`}><I className="h-4 w-4"/>{l}</button>)}</div><div className="card mt-4"><div className="text-xs text-gray-500">Assigned Pickup PIN(s)</div><div className="font-semibold mt-1">{(me.pickup_pins||[]).join(", ")||"None"}</div><div className="text-xs text-gray-500 mt-3">Commission</div><div className="font-bold">{me.commission_pct}%</div></div></aside>
  <main>{tab==="overview"&&<Overview me={me} data={data}/>} {tab==="drop_places"&&<DropPlaces me={me} data={data.drop_places} can={can} reload={load}/>} {tab==="payments"&&<ManagerPayments rows={data.payouts} settings={paymentSettings} setSettings={setPaymentSettings} managerId={me.id}/>} {tab!=="overview"&&tab!=="drop_places"&&tab!=="payments"&&<TableView title={labels[tab]} rows={data[tab]||[]} />}</main></div></div>
}
function Overview({me,data}){return <div className="space-y-4"><h1 className="font-display text-3xl font-bold">Manager Overview</h1><p className="text-gray-500">Assigned Pickup PIN service data only.</p><div className="grid grid-cols-2 md:grid-cols-4 gap-3">{[["Customers",data.customers.length],["Drivers",data.drivers.length],["Bookings",data.bookings.length],["Drop Places",data.drop_places.length]].map(([l,v])=><div className="card" key={l}><div className="text-xs text-gray-500">{l}</div><div className="text-2xl font-bold mt-1">{v}</div></div>)}</div>{data.commission&&<div className="card"><b>Manager Commission</b><div className="grid grid-cols-3 gap-3 mt-3"><div>Earned<br/><b>₹{data.commission.earnings}</b></div><div>Paid<br/><b>₹{data.commission.paid}</b></div><div>Remaining<br/><b>₹{data.commission.remaining}</b></div></div></div>}</div>}
function TableView({title,rows}){return <div className="card"><h2 className="font-display text-xl font-bold">{title}</h2><div className="mt-4 overflow-x-auto"><table className="w-full text-sm"><tbody>{rows.slice(0,100).map((r,i)=><tr key={r.id||i} className="border-t"><td className="py-3 pr-4 font-semibold">{r.name||r.customer_name||r.place_name||r.vehicle_type||r.id}</td><td>{r.mobile||r.status||r.plate_no||r.fare||"—"}</td><td>{r.pickup_pin||r.drop_location||r.created_at||""}</td></tr>)}</tbody></table>{!rows.length&&<div className="text-gray-500 mt-4">No data available.</div>}</div></div>}
function DropPlaces({me,data,can,reload}){
 const [f,setF]=useState({place_name:"",latitude:"",longitude:"",pickup_pin:(me.pickup_pins||[])[0]||""});
 const add=async()=>{if(!f.place_name||!f.latitude||!f.longitude)return toast.error("Place name and coordinates are required");try{await api.post("/manager/drop-places",{...f,latitude:Number(f.latitude),longitude:Number(f.longitude),enabled:true},{headers:{"x-role":"manager"}});toast.success("Drop Place saved");setF({...f,place_name:"",latitude:"",longitude:""});reload()}catch(e){toast.error(e.response?.data?.detail||"Save failed")}};
 const edit=async(p)=>{if(!can("drop_places","edit"))return;const name=window.prompt("Place name",p.place_name);if(!name||name===p.place_name)return;try{await api.patch(`/manager/drop-places/${p.id}`,{place_name:name},{headers:{"x-role":"manager"}});reload();toast.success("Place updated")}catch(e){toast.error(e.response?.data?.detail||"Update failed")}};
 const toggle=async(p)=>{if(!can("drop_places","enable_disable"))return;try{await api.patch(`/manager/drop-places/${p.id}`,{enabled:!p.enabled},{headers:{"x-role":"manager"}});reload()}catch(e){toast.error(e.response?.data?.detail||"Update failed")}};
 return <div className="space-y-4"><div className="card"><div className="flex justify-between"><h2 className="font-display text-xl font-bold">Drop Places</h2><span className="text-xs text-blue-600">Only Admin/authorized Manager places</span></div>{can("drop_places","add")&&<div className="grid md:grid-cols-4 gap-2 mt-4"><input className="field" placeholder="Place name" value={f.place_name} onChange={e=>setF({...f,place_name:e.target.value})}/><input className="field" placeholder="Latitude" value={f.latitude} onChange={e=>setF({...f,latitude:e.target.value})}/><input className="field" placeholder="Longitude" value={f.longitude} onChange={e=>setF({...f,longitude:e.target.value})}/><button className="brand-btn" onClick={add}><Plus className="h-4 w-4 inline"/> Add Place</button></div>}</div><div className="card"><h2 className="font-display text-xl font-bold">Saved Drop Places</h2><div className="mt-4 space-y-2">{data.map(p=><div key={p.id} className="border rounded-xl p-3 flex items-center justify-between gap-3"><div><b>{p.place_name}</b><div className="text-xs text-gray-500">{p.enabled?"Enabled":"Disabled"} • Pickup PIN {p.pickup_pin||"Global"}</div></div><div className="flex gap-2">{can("drop_places","edit")&&<button className="h-9 px-3 rounded-lg bg-gray-100" onClick={()=>edit(p)}>Edit</button>}{can("drop_places","enable_disable")&&<button className="h-9 px-3 rounded-lg bg-gray-100" onClick={()=>toggle(p)}>{p.enabled?"Disable":"Enable"}</button>}</div></div>)}{!data.length&&<div className="text-gray-500">No Drop Places available.</div>}</div></div></div>
}

function ManagerPayments({rows,settings,setSettings,managerId}){
 const [upi,setUpi]=useState(settings?.upi_id||"");
 useEffect(()=>setUpi(settings?.upi_id||""),[settings?.upi_id]);
 const save=async()=>{try{const r=await api.put(`/payment-settings/manager/${managerId}`,{upi_id:upi,qr_file_id:settings?.qr_file_id||null,active:true},{headers:{"x-role":"manager"}});setSettings(r.data);toast.success("Manager UPI/QR saved")}catch(e){toast.error(e.response?.data?.detail||"Save failed")}};
 const upload=async(e)=>{const file=e.target.files?.[0];if(!file)return;const fd=new FormData();fd.append("file",file);try{const r=await api.post("/upload",fd,{headers:{"x-role":"manager"}});setSettings(s=>({...s,qr_file_id:r.data.id}));toast.success("QR uploaded")}catch(err){toast.error(err.response?.data?.detail||"QR upload failed")}};
 return <div className="space-y-4"><h2 className="font-display text-2xl font-bold">Admin Payments</h2><div className="card"><div className="font-semibold mb-3">Manager UPI / QR for Admin Payout</div><div className="grid md:grid-cols-3 gap-2"><input className="field" placeholder="Manager UPI ID" value={upi} onChange={e=>setUpi(e.target.value)}/><input className="field" type="file" accept="image/png,image/jpeg,image/webp" onChange={upload}/><button className="brand-btn" onClick={save}>Save UPI / QR</button></div>{settings?.qr_file_id&&<img src={fileUrl(settings.qr_file_id)} className="mt-3 h-40 w-40 rounded-xl object-contain border" alt="Manager QR"/>}</div><div className="card overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-gray-500"><th className="py-2">Amount</th><th>Status</th><th>Receipt</th><th>Date</th></tr></thead><tbody>{rows.map(r=><tr key={r.id} className="border-t"><td className="py-3 font-semibold">₹{r.amount}</td><td>{r.status}</td><td>{r.receipt_file_id||"—"}</td><td>{r.paid_at||r.created_at}</td></tr>)}</tbody></table>{!rows.length&&<div className="text-gray-500 py-4">No payment history.</div>}</div></div>}
