export type LogisticsCostSample = {
  carrierService: string;
  chargeableWeightG: number;
  actualCostCny: number;
  completedTransitDays: number | null;
};

export type LogisticsBenchmark = {
  carrierService: string;
  sampleCount: number;
  averageActualCostCny: number;
  weightedCostPerKgCny: number;
  minimumActualCostCny: number;
  maximumActualCostCny: number;
  completedTransitSampleCount: number;
  typicalTransitDays: number | null;
  confidenceLabel: "样本较少" | "中等" | "较高";
  modelKind: "linear" | "median";
  fixedComponentCny: number;
  variablePerKgCny: number;
  medianActualCostCny: number;
};

function median(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

function confidence(sampleCount: number): LogisticsBenchmark["confidenceLabel"] {
  if (sampleCount >= 8) return "较高";
  if (sampleCount >= 5) return "中等";
  return "样本较少";
}

export function buildLogisticsBenchmarks(samples: LogisticsCostSample[]): LogisticsBenchmark[] {
  const groups = new Map<string, LogisticsCostSample[]>();
  for (const sample of samples) {
    const key = sample.carrierService.trim();
    if (!key || sample.chargeableWeightG <= 0 || sample.actualCostCny <= 0) continue;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }

  return [...groups].map(([carrierService, group]) => {
    const weightsKg = group.map((sample) => sample.chargeableWeightG / 1000);
    const costs = group.map((sample) => sample.actualCostCny);
    const averageWeight = weightsKg.reduce((sum, value) => sum + value, 0) / group.length;
    const averageCost = costs.reduce((sum, value) => sum + value, 0) / group.length;
    const denominator = weightsKg.reduce((sum, value) => sum + (value - averageWeight) ** 2, 0);
    const slope = denominator > 0
      ? weightsKg.reduce(
          (sum, value, index) => sum + (value - averageWeight) * (costs[index] - averageCost),
          0,
        ) / denominator
      : 0;
    const intercept = averageCost - slope * averageWeight;
    const useLinearModel = group.length >= 3 && slope >= 0 && intercept >= 0;
    const transitSamples = group.flatMap((sample) =>
      sample.completedTransitDays === null ? [] : [sample.completedTransitDays]
    );

    return {
      carrierService,
      sampleCount: group.length,
      averageActualCostCny: averageCost,
      weightedCostPerKgCny:
        costs.reduce((sum, value) => sum + value, 0)
        / weightsKg.reduce((sum, value) => sum + value, 0),
      minimumActualCostCny: Math.min(...costs),
      maximumActualCostCny: Math.max(...costs),
      completedTransitSampleCount: transitSamples.length,
      typicalTransitDays: transitSamples.length ? median(transitSamples) : null,
      confidenceLabel: confidence(group.length),
      modelKind: useLinearModel ? "linear" : "median",
      fixedComponentCny: useLinearModel ? intercept : median(costs),
      variablePerKgCny: useLinearModel ? slope : 0,
      medianActualCostCny: median(costs),
    } satisfies LogisticsBenchmark;
  }).sort((a, b) => a.carrierService.localeCompare(b.carrierService));
}

export function estimateShipmentCost(benchmark: LogisticsBenchmark, chargeableWeightG: number) {
  if (!Number.isFinite(chargeableWeightG) || chargeableWeightG <= 0) return null;
  if (benchmark.modelKind === "median") return benchmark.medianActualCostCny;
  return benchmark.fixedComponentCny
    + benchmark.variablePerKgCny * (chargeableWeightG / 1000);
}

export function allocateEstimateByWeight(totalCostCny: number, weightsG: number[]) {
  const validWeights = weightsG.filter((weight) => Number.isFinite(weight) && weight > 0);
  const totalWeight = validWeights.reduce((sum, weight) => sum + weight, 0);
  if (!totalWeight) return [];
  return validWeights.map((weight) => ({
    weightG: weight,
    share: weight / totalWeight,
    amountCny: totalCostCny * weight / totalWeight,
  }));
}
