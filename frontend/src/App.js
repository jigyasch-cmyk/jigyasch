import "@/App.css";
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
  const token = localStorage.getItem("avsgo_driver_token");

  return token ? children : <Navigate to="/driver/register" replace />;
}

function AdminGate({ children }) {
  const token = localStorage.getItem("avsgo_admin_token");

  return token ? children : <Navigate to="/admin/login" replace />;
}

function ManagerGate({ children }) {
  const token = localStorage.getItem("avsgo_manager_token");

  return token ? children : <Navigate to="/manager/login" replace />;
}

function DriverEntry() {
  const token = localStorage.getItem("avsgo_driver_token");

  if (token) {
    return <Navigate to="/driver" replace />;
  }

  return <DriverAuth />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-center" richColors />

      <Routes>
        <Route path="/" element={<Landing />} />

        <Route path="/customer" element={<Customer />} />

        {/* Driver registration / saved driver entry */}
        <Route path="/driver/register" element={<DriverEntry />} />

        {/* Driver panel */}
        <Route
          path="/driver"
          element={
            <DriverGate>
              <DriverDashboard />
            </DriverGate>
          }
        />

        {/* Admin */}
        <Route path="/admin/login" element={<AdminLogin />} />

        <Route
          path="/admin"
          element={
            <AdminGate>
              <AdminDashboard />
            </AdminGate>
          }
        />

        {/* Manager */}
        <Route path="/manager/login" element={<ManagerLogin />} />

        <Route
          path="/manager"
          element={
            <ManagerGate>
              <ManagerDashboard />
            </ManagerGate>
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
