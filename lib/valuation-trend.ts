const businessDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit",
});

type Valuation = { id: string; cameraId: string; valuedAt: string; medianCny: number };
export type ValuationTrendPoint = { day: string; label: string; value: number; assetCount: number };

/** Only observed asset/day values: no carry-forward, interpolation, or invented history. */
export function aggregateValuationTrend(valuations: readonly Valuation[]): ValuationTrendPoint[] {
  const days = new Map<string, Map<string, { valuation: Valuation; time: number; subMillisecond: number }>>();
  for (const valuation of valuations) {
    const time = Date.parse(valuation.valuedAt);
    if (!Number.isFinite(time) || !Number.isFinite(valuation.medianCny)) continue;
    const fraction = valuation.valuedAt.match(/\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i)?.[1] ?? "";
    const subMillisecond = Number(fraction.padEnd(9, "0").slice(3, 9));
    const parts = businessDate.formatToParts(time);
    const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
    const day = `${part("year")}-${part("month")}-${part("day")}`;
    const assets = days.get(day) ?? new Map();
    const previous = assets.get(valuation.cameraId);
    // Stable tie-break for identical timestamps, independent of query ordering.
    if (!previous || time > previous.time || (time === previous.time && (subMillisecond > previous.subMillisecond
      || (subMillisecond === previous.subMillisecond && valuation.id > previous.valuation.id)))) {
      assets.set(valuation.cameraId, { valuation, time, subMillisecond });
    }
    days.set(day, assets);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, assets]) => ({
    day, label: day.slice(5, 10), assetCount: assets.size,
    value: [...assets.values()].reduce((sum, { valuation }) => sum + Math.round(valuation.medianCny * 100), 0) / 100,
  }));
}

/** Reserve room for each date label; this never filters the underlying bars. */
export function trendLabelIndices(count: number, width: number): number[] {
  if (count <= 0) return [];
  const slots = Math.min(count, Math.max(1, Math.floor(width / 64)));
  if (slots === 1) return [count - 1];
  return Array.from({ length: slots }, (_, index) => Math.round(index * (count - 1) / (slots - 1)));
}
