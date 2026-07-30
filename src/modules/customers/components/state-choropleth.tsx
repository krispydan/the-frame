"use client";

import { useEffect, useState } from "react";
import { MapContainer, GeoJSON } from "react-leaflet";
import type { Layer, PathOptions } from "leaflet";
import type { Feature, Geometry } from "geojson";
import "leaflet/dist/leaflet.css";

export interface StateRevenue {
  state: string; // 2-letter code, e.g. "CA"
  customers: number;
  revenue: number;
}

// 2-letter code → full state name (GeoJSON uses full names)
const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri",
  MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

function money(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

// Green sequential ramp (light → dark) for revenue intensity.
function colorForFraction(f: number): string {
  if (f <= 0) return "#f3f4f6"; // no data — light gray
  if (f > 0.8) return "#14532d";
  if (f > 0.6) return "#166534";
  if (f > 0.4) return "#16a34a";
  if (f > 0.2) return "#4ade80";
  if (f > 0.05) return "#bbf7d0";
  return "#dcfce7";
}

interface GeoFeatureProps { name: string }

/**
 * US choropleth of revenue by state. Loads a bundled states GeoJSON and
 * shades each state by its share of the max state's revenue. Hover shows
 * the state's revenue + customer count. Client-only (Leaflet).
 */
export default function StateChoropleth({ data }: { data: StateRevenue[] }) {
  const [geo, setGeo] = useState<GeoJSON.FeatureCollection | null>(null);

  useEffect(() => {
    fetch("/geo/us-states.json")
      .then((r) => r.json())
      .then(setGeo)
      .catch(() => setGeo(null));
  }, []);

  // Build lookup by full state name → revenue/customers
  const byName = new Map<string, StateRevenue>();
  for (const d of data) {
    const name = STATE_NAMES[d.state];
    if (name) byName.set(name, d);
  }
  const maxRevenue = Math.max(1, ...data.map((d) => d.revenue));

  if (!geo) {
    return <div className="h-[420px] flex items-center justify-center bg-muted/40 rounded-lg text-muted-foreground">Loading map…</div>;
  }

  const styleFn = (feature?: Feature<Geometry, GeoFeatureProps>): PathOptions => {
    const rev = feature ? byName.get(feature.properties.name)?.revenue ?? 0 : 0;
    return {
      fillColor: colorForFraction(rev / maxRevenue),
      weight: 1,
      color: "#ffffff",
      fillOpacity: 0.85,
    };
  };

  const onEachFeature = (feature: Feature<Geometry, GeoFeatureProps>, layer: Layer) => {
    const d = byName.get(feature.properties.name);
    const label = d
      ? `<strong>${feature.properties.name}</strong><br/>${money(d.revenue)} · ${d.customers} customer${d.customers === 1 ? "" : "s"}`
      : `<strong>${feature.properties.name}</strong><br/><span style="color:#9ca3af">No customers</span>`;
    layer.bindTooltip(label, { sticky: true });
  };

  return (
    <MapContainer
      center={[37.8, -96]}
      zoom={4}
      scrollWheelZoom={false}
      dragging={false}
      doubleClickZoom={false}
      zoomControl={false}
      attributionControl={false}
      style={{ height: "420px", width: "100%", borderRadius: "0.5rem", background: "transparent", zIndex: 0 }}
    >
      <GeoJSON data={geo} style={styleFn} onEachFeature={onEachFeature} />
    </MapContainer>
  );
}
