"use client";

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.heat";

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

// Below this zoom we show a heatmap (density overview); at/above we show
// individual store markers.
const PIN_ZOOM_THRESHOLD = 6;

function radiusForLtv(ltv: number): number {
  if (ltv <= 0) return 4;
  return Math.min(20, 4 + Math.sqrt(ltv) / 8);
}

function money(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

/** Track the map's current zoom so the parent can switch heat ↔ pins. */
function ZoomWatcher({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) });
  useEffect(() => { onZoom(map.getZoom()); }, [map, onZoom]);
  return null;
}

/** Imperative heatmap layer (leaflet.heat). Intensity weighted by LTV so
 *  high-value clusters glow hotter. */
function HeatLayer({ points }: { points: GeoPoint[] }) {
  const map = useMap();
  useEffect(() => {
    const maxLtv = Math.max(1, ...points.map((p) => p.ltv));
    const heatData: [number, number, number][] = points.map((p) => [
      p.lat,
      p.lng,
      Math.max(0.15, Math.min(1, (p.ltv || 0) / maxLtv)),
    ]);
    // L.heatLayer is attached by the leaflet.heat side-effect import.
    const layer = (L as unknown as {
      heatLayer: (d: [number, number, number][], o: object) => L.Layer;
    }).heatLayer(heatData, { radius: 28, blur: 20, maxZoom: PIN_ZOOM_THRESHOLD, minOpacity: 0.35 });
    layer.addTo(map);
    return () => { map.removeLayer(layer); };
  }, [map, points]);
  return null;
}

/**
 * Customer map: heatmap when zoomed out (density overview), individual
 * store markers when zoomed in past the threshold. Client-only (Leaflet
 * touches window). CircleMarkers are SVG so no marker-icon assets break.
 */
export default function CustomerMap({ points }: { points: GeoPoint[] }) {
  const [zoom, setZoom] = useState(4);
  const showPins = zoom >= PIN_ZOOM_THRESHOLD;

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
      <ZoomWatcher onZoom={setZoom} />

      {showPins ? (
        points.map((p) => (
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
        ))
      ) : (
        <HeatLayer points={points} />
      )}
    </MapContainer>
  );
}
