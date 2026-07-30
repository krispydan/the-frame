"use client";

import { MapContainer, TileLayer, CircleMarker, Tooltip } from "react-leaflet";
import "leaflet/dist/leaflet.css";

export interface GeoPoint {
  companyId: string;
  name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  lat: number;
  lng: number;
  tier: string;
  ltv: number;
  orders: number;
  health: string;
}

const HEALTH_COLOR: Record<string, string> = {
  healthy: "#16a34a",
  at_risk: "#d97706",
  churning: "#dc2626",
  churned: "#991b1b",
};

function radiusForLtv(ltv: number): number {
  // 5px floor, grows with sqrt of LTV, capped so whales don't swamp the map
  if (ltv <= 0) return 4;
  return Math.min(20, 4 + Math.sqrt(ltv) / 8);
}

function money(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

/**
 * Leaflet map plotting every geocoded customer. Colored by health, sized by
 * lifetime value. Rendered client-only (imported via next/dynamic ssr:false)
 * since Leaflet touches window. Uses CircleMarker (SVG) so there are no
 * marker-icon asset paths to break in the bundler.
 */
export default function CustomerMap({ points }: { points: GeoPoint[] }) {
  return (
    <MapContainer
      center={[39.5, -98.35]} // geographic center of the US
      zoom={4}
      scrollWheelZoom
      style={{ height: "480px", width: "100%", borderRadius: "0.5rem", zIndex: 0 }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {points.map((p) => (
        <CircleMarker
          key={p.companyId}
          center={[p.lat, p.lng]}
          radius={radiusForLtv(p.ltv)}
          pathOptions={{
            color: HEALTH_COLOR[p.health] || "#6b7280",
            fillColor: HEALTH_COLOR[p.health] || "#6b7280",
            fillOpacity: 0.55,
            weight: 1.5,
          }}
        >
          <Tooltip direction="top" offset={[0, -4]}>
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>
              <strong>{p.name}</strong>
              <br />
              {[p.city, p.state, p.country && p.country !== "US" ? p.country : null].filter(Boolean).join(", ")}
              <br />
              {money(p.ltv)} · {p.orders} order{p.orders === 1 ? "" : "s"} · {p.tier}
              <br />
              <span style={{ color: HEALTH_COLOR[p.health] || "#6b7280", fontWeight: 600 }}>
                {p.health.replace("_", " ")}
              </span>
            </div>
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
