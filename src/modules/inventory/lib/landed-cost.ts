/**
 * Landed Cost Calculator
 * 
 * Per-unit landed cost = unit_cost + (shipping / units) + (duties / units) + (freight / units)
 * Margin = (wholesale_price - landed_cost) / wholesale_price
 */

// Default cost settings (configurable)
export const DEFAULT_COST_SETTINGS = {
  dutyRate: 0.06,        // 6% duty rate for eyewear (HTS 9004)
  freightPerContainer: 3500, // USD per 20ft container
  unitsPerContainer: 5000,   // average units per container
  insuranceRate: 0.005,      // 0.5% of FOB value
  customsBrokerFee: 250,     // flat fee per shipment
};

export type LandedCostSettings = typeof DEFAULT_COST_SETTINGS;

export type LandedCostResult = {
  unitCost: number;
  shippingPerUnit: number;
  dutiesPerUnit: number;
  freightPerUnit: number;
  insurancePerUnit: number;
  brokerFeePerUnit: number;
  landedCost: number;
  wholesalePrice: number;
  wholesaleMargin: number;
  wholesaleMarginPct: number;
  retailPrice: number;
  retailMargin: number;
  retailMarginPct: number;
};

/**
 * Calculate landed cost for a single unit.
 */
export function calculateLandedCost(
  unitCost: number,
  wholesalePrice: number,
  retailPrice: number,
  totalUnits: number,
  shippingCost: number = 0,
  dutiesCost: number = 0,
  freightCost: number = 0,
  settings: LandedCostSettings = DEFAULT_COST_SETTINGS
): LandedCostResult {
  const shippingPerUnit = totalUnits > 0 ? shippingCost / totalUnits : 0;
  
  // If duties not provided, estimate from duty rate
  const dutiesPerUnit = totalUnits > 0 && dutiesCost > 0
    ? dutiesCost / totalUnits
    : unitCost * settings.dutyRate;
  
  // If freight not provided, estimate from container rate
  const freightPerUnit = totalUnits > 0 && freightCost > 0
    ? freightCost / totalUnits
    : settings.freightPerContainer / settings.unitsPerContainer;

  const insurancePerUnit = unitCost * settings.insuranceRate;
  const brokerFeePerUnit = totalUnits > 0
    ? settings.customsBrokerFee / totalUnits
    : settings.customsBrokerFee / 1000;

  const landedCost = Math.round(
    (unitCost + shippingPerUnit + dutiesPerUnit + freightPerUnit + insurancePerUnit + brokerFeePerUnit) * 100
  ) / 100;

  const wholesaleMargin = wholesalePrice - landedCost;
  const wholesaleMarginPct = wholesalePrice > 0
    ? Math.round((wholesaleMargin / wholesalePrice) * 10000) / 100
    : 0;

  const retailMargin = retailPrice - landedCost;
  const retailMarginPct = retailPrice > 0
    ? Math.round((retailMargin / retailPrice) * 10000) / 100
    : 0;

  return {
    unitCost,
    shippingPerUnit: Math.round(shippingPerUnit * 100) / 100,
    dutiesPerUnit: Math.round(dutiesPerUnit * 100) / 100,
    freightPerUnit: Math.round(freightPerUnit * 100) / 100,
    insurancePerUnit: Math.round(insurancePerUnit * 100) / 100,
    brokerFeePerUnit: Math.round(brokerFeePerUnit * 100) / 100,
    landedCost,
    wholesalePrice,
    wholesaleMargin: Math.round(wholesaleMargin * 100) / 100,
    wholesaleMarginPct,
    retailPrice,
    retailMargin: Math.round(retailMargin * 100) / 100,
    retailMarginPct,
  };
}

/**
 * Calculate landed cost for a PO (uses actual shipping/duties/freight from PO if available).
 */
export function calculatePOLandedCost(
  unitCost: number,
  wholesalePrice: number,
  retailPrice: number,
  poTotalUnits: number,
  poShippingCost: number,
  poDutiesCost: number,
  poFreightCost: number,
): LandedCostResult {
  return calculateLandedCost(
    unitCost,
    wholesalePrice,
    retailPrice,
    poTotalUnits,
    poShippingCost,
    poDutiesCost,
    poFreightCost,
  );
}
