import "@/App.css";
import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";

const Landing = lazy(() => import("@/pages/Landing"));
const Customer = lazy(() => import("@/pages/Customer"));
const DriverAuth = lazy(() => import("@/pages/DriverAuth"));
const DriverDashboard = lazy(() => import("@/pages/DriverDashboard"));
const AdminLogin = lazy(() => import("@/pages/AdminLogin"));
const AdminDashboard = lazy(() => import("@/pages/AdminDashboard"));
const ManagerLogin = lazy(() => import("@/pages/ManagerLogin"));
const ManagerDashboard = lazy(() => import("@/pages/ManagerDashboard"));

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
  return token ? (
    <Navigate to="/driver" replace />
  ) : (
    <DriverAuth />
  );
}

function PageLoading() {
  return (
    <div
      className="min-h-screen flex items-center justify-center bg-white text-sm text-gray-600"
      role="status"
      aria-live="polite"
    >
      AvSGo loading...
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-center" richColors />

      <Suspense fallback={<PageLoading />}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/customer" element={<Customer />} />

          <Route path="/driver/register" element={<DriverEntry />} />

          <Route
            path="/driver"
            element={
              <DriverGate>
                <DriverDashboard />
              </DriverGate>
            }
          />

          <Route path="/admin/login" element={<AdminLogin />} />

          <Route
            path="/admin"
            element={
              <AdminGate>
                <AdminDashboard />
              </AdminGate>
            }
          />

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
      </Suspense>
    </BrowserRouter>
  );
}
