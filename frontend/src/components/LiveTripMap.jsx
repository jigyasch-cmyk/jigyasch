import { useEffect, useRef } from "react";
import { loadLeaflet } from "@/lib/leaflet";

export default function LiveTripMap({ pickup, drop, driverLocation, customerLocation, geometry, stage, height="h-80" }) {
  const ref = useRef(null), mapRef = useRef(null), layers = useRef({});
  useEffect(() => {
    let cancelled=false;
    loadLeaflet().then(L=>{
      if(cancelled || !ref.current || mapRef.current) return;
      const start = driverLocation || customerLocation || pickup || drop || {lat:26.14,lng:91.73};
      const map=L.map(ref.current,{zoomControl:false,attributionControl:false}).setView([start.lat,start.lng],14);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19}).addTo(map);
      L.control.zoom({position:"bottomright"}).addTo(map); mapRef.current=map;
      setTimeout(()=>map.invalidateSize(),80);
    });
    return()=>{cancelled=true;if(mapRef.current){try{mapRef.current.remove()}catch{} mapRef.current=null;}};
  },[]);
  useEffect(()=>{
    if(!mapRef.current || !window.L) return; const L=window.L, map=mapRef.current;
    const put=(key,pos,color,label)=>{
      if(!pos) return;
      const icon=L.divIcon({className:"",html:`<div style="display:flex;flex-direction:column;align-items:center"><div style="background:${color};color:white;border:2px solid white;border-radius:999px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;font-weight:800;box-shadow:0 2px 6px #0005">${label}</div></div>`,iconSize:[30,30],iconAnchor:[15,15]});
      if(!layers.current[key]) layers.current[key]=L.marker([pos.lat,pos.lng],{icon}).addTo(map); else layers.current[key].setLatLng([pos.lat,pos.lng]).setIcon(icon);
    };
    const remove=k=>{if(layers.current[k]){map.removeLayer(layers.current[k]);delete layers.current[k];}};
    put("pickup",pickup,"#059669","P"); put("drop",drop,"#dc2626","D");
    put("driver",driverLocation,"#2563eb","🚗"); put("customer",customerLocation,"#f59e0b","C");
    if(layers.current.route){map.removeLayer(layers.current.route);delete layers.current.route;}
    if(geometry?.length>1) layers.current.route=L.polyline(geometry,{color:"#111827",weight:5,opacity:.85}).addTo(map);
    const pts=[]; [pickup,drop,driverLocation,customerLocation].forEach(p=>p&&pts.push([p.lat,p.lng])); if(geometry?.length>1) geometry.forEach(p=>pts.push(p));
    if(pts.length>1) map.fitBounds(L.latLngBounds(pts),{padding:[35,35],maxZoom:16}); else if(pts.length===1) map.setView(pts[0],16);
    setTimeout(()=>map.invalidateSize(),60);
  },[pickup,drop,driverLocation,customerLocation,geometry,stage]);
  return <div className={`relative w-full ${height} rounded-2xl overflow-hidden border border-gray-200 bg-gray-100`}><div ref={ref} className="absolute inset-0"/><div className="absolute top-2 left-2 z-[500] bg-white/95 rounded-lg px-3 py-1.5 text-xs font-bold shadow">{stage === "in_trip" ? "Live Trip • Pickup → Drop" : "Driver → Pickup • Live"}</div></div>;
}
