import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldCheck, Phone, Lock, User } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

export default function AdminLogin() {
  const nav = useNavigate();
  const [registered, setRegistered] = useState(true);
  const [form, setForm] = useState({ name: "", mobile: "", password: "" });
  const [loading, setLoading] = useState(false);

  useEffect(() => { api.get("/auth/admin/status").then(r => setRegistered(r.data.registered)).catch(() => {}); }, []);

  const submit = async () => {
    if (!form.mobile || form.mobile.length !== 10 || !form.password) return toast.error("Enter mobile and password");
    setLoading(true);
    try {
      const endpoint = registered ? "/auth/admin/login" : "/auth/admin/register";
      const payload = registered ? { mobile: form.mobile, password: form.password } : form;
      if (!registered && !form.name.trim()) return toast.error("Enter admin name");
      const r = await api.post(endpoint, payload);
      localStorage.setItem("avsgo_admin_token", r.data.token);
      toast.success(registered ? "Admin login successful" : "Admin registered and saved");
      nav("/admin");
    } catch (e) { toast.error(e.response?.data?.detail || "Request failed"); }
    finally { setLoading(false); }
  };

  return <div className="mobile-shell">
    <div className="px-6 pt-10 pb-8">
      <div className="h-14 w-14 rounded-2xl bg-emerald-100 flex items-center justify-center"><ShieldCheck className="h-7 w-7 text-emerald-600" /></div>
      <h1 className="font-display text-3xl font-bold mt-4">{registered ? "Admin Login" : "Admin Registration"}</h1>
      <p className="text-gray-500 mt-1">{registered ? "Enter your saved admin account" : "Create the first AvSGo admin account"}</p>
      <div className="mt-6 space-y-3">
        {!registered && <div className="relative"><User className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400"/><input className="field pl-12" placeholder="Admin name" value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></div>}
        <div className="relative"><Phone className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400"/><input className="field pl-12" placeholder="Mobile number" value={form.mobile} onChange={e=>setForm({...form,mobile:e.target.value.replace(/\D/g,"").slice(0,10)})}/></div>
        <div className="relative"><Lock className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400"/><input className="field pl-12" type="password" placeholder="Password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></div>
        <button className="brand-btn w-full" onClick={submit} disabled={loading}>{loading ? "Please wait…" : registered ? "Login" : "Register & Save"}</button>
      </div>
    </div>
  </div>;
}
