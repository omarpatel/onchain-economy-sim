import { cr } from "./units.ts";

/** Logistics constants. Transport is a real constraint: fleet capacity caps
 *  how much weight a company can move per tick; remote tiles cost more to run
 *  (each plant pays `ratePerWeightTile` per unit of weight per tile of
 *  distance to the company hub for what it actually produces). */
export const LOGI = {
  ratePerWeightTile: cr(0.03), // CR per (weight * tile) hauled
  truckCapacity: 700, // weight/tick per truck
  truckCostCr: cr(1500), // capex per truck
} as const;

export interface HaulLeg {
  weight: number; // total weight moved on this leg per tick at full throughput
  distance: number; // tiles from building to HQ hub
}

export interface HaulResult {
  demandWeight: number; // weight the company wants to move
  capacity: number; // fleet capacity
  utilization: number; // demand / capacity
  throttle: number; // 0..1 production scalar when over capacity
}

/**
 * Plan haulage for a set of legs against a truck fleet. When demanded weight
 * exceeds fleet capacity, production is throttled proportionally.
 */
export function haulPlan(legs: HaulLeg[], trucks: number): HaulResult {
  const demandWeight = legs.reduce((a, l) => a + l.weight, 0);
  const capacity = Math.max(LOGI.truckCapacity, trucks * LOGI.truckCapacity);
  const throttle = demandWeight <= capacity ? 1 : capacity / demandWeight;
  return { demandWeight, capacity, utilization: demandWeight / capacity, throttle };
}
