import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Car, Phone, User, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

export default function DriverAuth() {
  const nav = useNavigate();
  const [form, setForm] = useState({name:"", mobile:""});
  const [loading,setLoading]=useState(false);
  const submit=async()=>{
    if(!form.name.trim()) return toast.error("Enter driver name");
    if(form.mobile.length!==10) return toast.error("Enter valid 10-digit mobile");
    setLoading(true);
    try{
      const r=await api.post("/auth/driver/register",{...form,pickup_pin:""});
      localStorage.setItem("avsgo_driver_token",r.data.token);
      localStorage.setItem("avsgo_driver",JSON.stringify(r.data.driver));
      toast.success("Driver registration saved");
      nav("/driver");
    }catch(e){toast.error(e.response?.data?.detail||"Registration failed");}
    finally{setLoading(false);}
  };
  return <div className="mobile-shell"><div className="px-6 pt-10 pb-8">
    <div className="h-14 w-14 rounded-2xl bg-emerald-100 flex items-center justify-center"><Car className="h-7 w-7 text-emerald-600"/></div>
    <h1 className="font-display text-3xl font-bold mt-4">Driver Registration</h1>
    <p className="text-gray-500 mt-1">Register once. No driver login is required.</p>
    <div className="mt-6 space-y-3">
      <div className="relative"><User className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400"/><input className="field pl-12" placeholder="Driver name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></div>
      <div className="relative"><Phone className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400"/><input className="field pl-12" placeholder="Mobile number" value={form.mobile} onChange={e=>setForm({...form,mobile:e.target.value.replace(/\D/g,"").slice(0,10)})}/></div>
      <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 text-sm text-blue-800">No Pickup PIN restriction for drivers. Any approved, active and online driver can receive nearby booking requests. Manager/service-area association is handled separately by Admin.</div>
      <button className="brand-btn w-full" onClick={submit} disabled={loading}>{loading?"Saving…":"Register & Continue"}</button>
      <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800 flex gap-2"><CheckCircle2 className="h-5 w-5 shrink-0"/>Admin/authorized Manager approval is required before the driver becomes active.</div>
    </div>
  </div></div>;
}
