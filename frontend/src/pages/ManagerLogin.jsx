import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BriefcaseBusiness, Lock, UserRound } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

export default function ManagerLogin() {
  const nav = useNavigate();
  const [form, setForm] = useState({ manager_id: "", password: "" });
  const [loading, setLoading] = useState(false);
  const submit = async () => {
    if (!form.manager_id || !form.password) return toast.error("Manager ID আৰু password দিয়ক");
    setLoading(true);
    try {
      const r = await api.post("/auth/manager/login", form);
      localStorage.setItem("avsgo_manager_token", r.data.token);
      localStorage.setItem("avsgo_manager_profile", JSON.stringify(r.data.manager));
      toast.success("Manager login successful");
      nav("/manager");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Login failed");
    } finally { setLoading(false); }
  };
  return <div className="mobile-shell">
    <div className="px-6 pt-10 pb-8">
      <div className="h-14 w-14 rounded-2xl bg-blue-100 flex items-center justify-center"><BriefcaseBusiness className="h-7 w-7 text-blue-600" /></div>
      <h1 className="font-display text-3xl font-bold mt-4">Manager Login</h1>
      <p className="text-gray-500 mt-1">Admin-এ দিয়া Manager ID আৰু password ব্যৱহাৰ কৰক</p>
      <div className="mt-6 space-y-3">
        <div className="relative"><UserRound className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400"/><input className="field pl-12" placeholder="Manager ID" value={form.manager_id} onChange={e=>setForm({...form,manager_id:e.target.value})}/></div>
        <div className="relative"><Lock className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400"/><input className="field pl-12" type="password" placeholder="Password" value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></div>
        <button className="brand-btn w-full" onClick={submit} disabled={loading}>{loading ? "Please wait…" : "Login"}</button>
      </div>
    </div>
  </div>;
}
