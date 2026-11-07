/**
 * census-geocoder: one row per address match (or per point), with the geographies flattened into columns. The
 * geocoder returns each geography layer as a list ("States": [{GEOID, NAME, ...}], "Census Tracts": [...]); a
 * point lies in one feature of each layer, so the row carries `<layer>.GEOID` and `<layer>.NAME` for every layer
 * (layer names follow the vintage, e.g. "120th Congressional Districts"), plus the convenient join keys
 * state_fips, county_fips (5 digits), tract_geoid (11) and block_geoid (15) when those layers are present.
 */
import type { Adapter, Row, SpecRequest } from "../core/packs.js";

const KEYS: [RegExp, string][] = [
  [/^States$/, "state_fips"],
  [/^Counties$/, "county_fips"],
  [/^Census Tracts$/, "tract_geoid"],
  [/Census Blocks$/, "block_geoid"],
];

/** The join keys first (state_fips, state_usps, county_fips, tract_geoid, block_geoid), then every layer. */
function geoColumns(geographies: Record<string, any[]> | undefined): Row {
  const keys: Row = { state_fips: "", state_usps: "", county_fips: "", tract_geoid: "", block_geoid: "" };
  const layers: Row = {};
  for (const [layer, features] of Object.entries(geographies || {})) {
    const f = Array.isArray(features) ? features[0] : undefined;
    if (!f) continue;
    layers[`${layer}.GEOID`] = f.GEOID ?? "";
    layers[`${layer}.NAME`] = f.NAME ?? f.BASENAME ?? "";
    for (const [rx, col] of KEYS) if (rx.test(layer) && keys[col] === "") keys[col] = f.GEOID ?? "";
    if (/^States$/.test(layer)) keys.state_usps = f.STUSAB ?? "";
  }
  return { ...keys, ...layers };
}

function addressRow(req: SpecRequest, m: any): Row {
  return {
    input: String(req.params?.address ?? ""),
    matched_address: m.matchedAddress ?? "",
    lon: m.coordinates?.x ?? "",
    lat: m.coordinates?.y ?? "",
    tiger_line_id: m.tigerLine?.tigerLineId ?? "",
    tiger_side: m.tigerLine?.side ?? "",
    ...geoColumns(m.geographies),
  };
}

const adapter: Adapter = {
  normalize(req, ep, rows) {
    if (ep.path === "/geographies/coordinates") {
      return rows.map((r: any) => ({ lon: req.params?.x ?? "", lat: req.params?.y ?? "", ...geoColumns(r.geographies) }));
    }
    if (ep.path?.endsWith("/onelineaddress")) return rows.map((m) => addressRow(req, m));
    return rows;
  },
};

export default adapter;
