import axios from "axios";

const BACKEND_URL = (process.env.REACT_APP_BACKEND_URL || "https://avsgo.onrender.com").replace(/\/$/, "");
export const API = `${BACKEND_URL}/api`;
export const WS_BASE = BACKEND_URL.replace(/^http/, "ws");
export const wsUrl = (path, params={}) => { const q = new URLSearchParams(params).toString(); return `${WS_BASE}${path}${q ? `?${q}` : ""}`; };

const client = axios.create({ baseURL: API });

client.interceptors.request.use((config) => {
  const role = config.headers?.["x-role"] || null;
  const token =
    role === "admin"
      ? localStorage.getItem("avsgo_admin_token")
      : role === "manager"
        ? localStorage.getItem("avsgo_manager_token")
        : localStorage.getItem("avsgo_driver_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (config.headers?.["x-role"]) delete config.headers["x-role"];
  return config;
});

export const fileUrl = (id) => (id ? `${API}/files/${id}` : null);

export default client;
