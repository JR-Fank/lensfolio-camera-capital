export type TransitTrackingEvent = {
  id: string;
  occurredAt: string;
  rawStatus: string;
  statusLabel: string;
  externalEventId?: string | null;
  legacyId?: string | null;
  recordedAt?: string | null;
};

export type TransitDuration = {
  transitDays: number | null;
  pickupWaitDays: number | null;
  isComplete: boolean;
  startAt: string | null;
  endAt: string | null;
  endKind: "collection_point" | "final_delivery" | "latest_event" | null;
};

const DISPATCH = "Dispatch from outward office of exchange";
const POSTING = "Posting/Collection";
const COLLECTION_POINT = "Item arrival at collection point for pick-up";
const FINAL_DELIVERY = "Final delivery";
const LEGACY_TIME_SHIFT_TOLERANCE_MS = 90 * 60 * 1000;

export function canonicalizeTrackingEvents<T extends TransitTrackingEvent>(events: T[]) {
  const canonical: T[] = [];
  for (const event of [...events].sort(compareOccurredAt)) {
    const duplicateIndex = canonical.findIndex((candidate) =>
      isCrossSourceNearDuplicate(candidate, event)
    );
    if (duplicateIndex < 0) {
      canonical.push(event);
      continue;
    }
    if (sourcePriority(event) > sourcePriority(canonical[duplicateIndex])) {
      canonical[duplicateIndex] = event;
    }
  }
  return canonical.sort(compareOccurredAt);
}

export function deriveTransitDuration(events: TransitTrackingEvent[]): TransitDuration {
  const canonical = canonicalizeTrackingEvents(events);
  const dispatch = firstEvent(canonical, DISPATCH);
  const posting = firstEvent(canonical, POSTING);
  const start = dispatch ?? posting;
  if (!start) return emptyDuration();

  const collectionPoint = firstEventAfter(canonical, COLLECTION_POINT, start.occurredAt);
  const finalDelivery = firstEventAfter(canonical, FINAL_DELIVERY, start.occurredAt);
  const latest = [...canonical].reverse().find((event) => occursAfter(event, start.occurredAt));
  const end = collectionPoint ?? finalDelivery ?? latest ?? null;
  const endKind = collectionPoint
    ? "collection_point"
    : finalDelivery
      ? "final_delivery"
      : end
        ? "latest_event"
        : null;
  const pickupWaitDays = collectionPoint && finalDelivery && occursAfter(finalDelivery, collectionPoint.occurredAt)
    ? daysBetween(collectionPoint.occurredAt, finalDelivery.occurredAt)
    : null;

  return {
    transitDays: end ? daysBetween(start.occurredAt, end.occurredAt) : null,
    pickupWaitDays,
    isComplete: endKind === "collection_point" || endKind === "final_delivery",
    startAt: start.occurredAt,
    endAt: end?.occurredAt ?? null,
    endKind,
  };
}

function isCrossSourceNearDuplicate(left: TransitTrackingEvent, right: TransitTrackingEvent) {
  if (normalizeStatus(left.rawStatus) !== normalizeStatus(right.rawStatus)) return false;
  if (sourcePriority(left) === sourcePriority(right)) return false;
  const difference = Math.abs(Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  return Number.isFinite(difference) && difference <= LEGACY_TIME_SHIFT_TOLERANCE_MS;
}

function sourcePriority(event: TransitTrackingEvent) {
  if (
    event.externalEventId?.startsWith("japan-post:")
    || event.legacyId?.startsWith("tracking:japan-post:")
  ) return 3;
  if (event.externalEventId?.startsWith("evidence:")) return 2;
  return 1;
}

function firstEvent(events: TransitTrackingEvent[], rawStatus: string) {
  return events.find((event) => normalizeStatus(event.rawStatus) === normalizeStatus(rawStatus));
}

function firstEventAfter(events: TransitTrackingEvent[], rawStatus: string, startAt: string) {
  return events.find((event) =>
    normalizeStatus(event.rawStatus) === normalizeStatus(rawStatus)
    && occursAfter(event, startAt)
  );
}

function occursAfter(event: TransitTrackingEvent, startAt: string) {
  return Date.parse(event.occurredAt) >= Date.parse(startAt);
}

function daysBetween(startAt: string, endAt: string) {
  const difference = Date.parse(endAt) - Date.parse(startAt);
  return Number.isFinite(difference) && difference >= 0 ? difference / 86_400_000 : null;
}

function compareOccurredAt(left: TransitTrackingEvent, right: TransitTrackingEvent) {
  return left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id);
}

function normalizeStatus(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function emptyDuration(): TransitDuration {
  return {
    transitDays: null,
    pickupWaitDays: null,
    isComplete: false,
    startAt: null,
    endAt: null,
    endKind: null,
  };
}
