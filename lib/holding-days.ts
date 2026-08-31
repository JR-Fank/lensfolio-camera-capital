const HONG_KONG_TIME_ZONE = "Asia/Hong_Kong";
const dateParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: HONG_KONG_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function hongKongDateOrdinal(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = Object.fromEntries(
    dateParts.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

export function calculateHoldingDays(
  acquiredAt: string | null,
  endedAt: string | null = null,
  now: Date = new Date(),
) {
  if (!acquiredAt) return 0;
  const start = hongKongDateOrdinal(acquiredAt);
  const end = hongKongDateOrdinal(endedAt ?? now);
  if (start === null || end === null) return 0;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}
