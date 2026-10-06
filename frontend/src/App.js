g import "@/App.css";
import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import Landing from "@/pages/Landing";
import Customer from "@/pages/Customer";
import DriverAuth from "@/pages/DriverAuth";
import DriverDashboard from "@/pages/DriverDashboard";
import AdminLogin from "@/pages/AdminLogin";
import AdminDashboard from "@/pages/AdminDashboard";
import ManagerLogin from "@/pages/ManagerLogin";
import ManagerDashboard from "@/pages/ManagerDashboard";

function DriverGate({ children }) {
  const t = localStorage.getItem("avsgo_driver_token");
  return t ? children : <Navigate to="/driver/login" replace />;
}
function AdminGate({ children }) {
  const t = localStorage.getItem("avsgo_admin_token");
  return t ? children : <Navigate to="/admin/login" replace />;
}
function ManagerGate({ children }) {
  const t = localStorage.getItem("avsgo_manager_token");
  return t ? children : <Navigate to="/manager/login" replace />;
}

export default function App() {
  useEffect(() => {
    // Give the splash a beat so it feels intentional rather than a flash
    const t = setTimeout(() => {
      if (typeof window !== "undefined" && typeof window.__avsgoHideSplash === "function") {
        window.__avsgoHideSplash();
      }
    }, 550);
    return () => clearTimeout(t);
  }, []);

  return (
    <BrowserRouter>
      <Toaster position="top-center" richColors />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/customer" element={<Customer />} />
        <Route path="/driver/register" element={<DriverAuth />} />
        <Route
          path="/driver"
          element={
            <DriverGate>
              <DriverDashboard />
            </DriverGate>
          }
        />
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/manager/login" element={<ManagerLogin />} />
        <Route
          path="/manager"
          element={
            <ManagerGate>
              <ManagerDashboard />
            </ManagerGate>
          }
        />
        <Route
          path="/admin"
          element={
            <AdminGate>
              <AdminDashboard />
            </AdminGate>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
