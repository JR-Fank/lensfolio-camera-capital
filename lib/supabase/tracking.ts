import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deriveJapanPostShipmentState,
  fetchJapanPostTracking,
  isJapanPostTrackingNumber,
  japanPostEventFingerprint,
  japanPostEventLocation,
  type JapanPostTrackingEvent,
} from "../tracking/japan-post.ts";
import type { PortfolioRole } from "./portfolio-access";

type TrackingShipment = {
  id: string;
  portfolio_id: string;
  carrier: string | null;
  tracking_number: string | null;
  status: string;
};

type PersistedTrackingEvent = {
  event_fingerprint: string;
  occurred_at: string;
  raw_status: string;
  status_label: string;
  description: string | null;
  location: string | null;
};

type CompletedSync = {
  run_id: string;
  shipment_id: string;
  events_seen: number;
  events_inserted: number;
  shipment_status: string;
  shipped_at: string | null;
  delivered_at: string | null;
  latest_status: string;
};

export type TrackingSyncStore = {
  getShipment(shipmentId: string): Promise<TrackingShipment | null>;
  getRole(portfolioId: string, userId: string): Promise<PortfolioRole | null>;
  startRun(input: {
    runId: string;
    portfolioId: string;
    shipmentId: string;
    userId: string;
    startedAt: string;
  }): Promise<void>;
  completeRun(input: {
    runId: string;
    shipmentId: string;
    finishedAt: string;
    events: PersistedTrackingEvent[];
  }): Promise<CompletedSync>;
  failRun(input: {
    runId: string;
    finishedAt: string;
    message: string;
  }): Promise<void>;
};

type TrackingFetcher = (trackingNumber: string) => Promise<{
  trackingNumber: string;
  events: JapanPostTrackingEvent[];
}>;

export class TrackingSyncError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TrackingSyncError";
    this.status = status;
  }
}

export function assertTrackingWriteRole(role: PortfolioRole | null) {
  if (role !== "owner" && role !== "editor") {
    throw new TrackingSyncError("只有 owner 或 editor 可以同步物流。", 403);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "物流同步失败";
}

function isJapanPostCarrier(carrier: string | null) {
  return Boolean(carrier && (carrier.includes("日本邮政") || carrier.includes("EMS")));
}

async function eventsForPersistence(
  trackingNumber: string,
  events: JapanPostTrackingEvent[],
) {
  return Promise.all(events.map(async (event) => ({
    event_fingerprint: await japanPostEventFingerprint(trackingNumber, event),
    occurred_at: event.occurredAt,
    raw_status: event.rawStatus,
    status_label: event.statusLabel,
    description: event.details || null,
    location: japanPostEventLocation(event),
  })));
}

export async function runManualTrackingSync({
  store,
  userId,
  shipmentId,
  fetchTracking = fetchJapanPostTracking,
  now = () => new Date(),
  createId = () => crypto.randomUUID(),
}: {
  store: TrackingSyncStore;
  userId: string;
  shipmentId: string;
  fetchTracking?: TrackingFetcher;
  now?: () => Date;
  createId?: () => string;
}) {
  const shipment = await store.getShipment(shipmentId);
  if (!shipment) {
    throw new TrackingSyncError("没有找到可访问的物流批次。", 404);
  }

  assertTrackingWriteRole(await store.getRole(shipment.portfolio_id, userId));

  if (!isJapanPostCarrier(shipment.carrier)) {
    throw new TrackingSyncError("当前手动同步仅支持日本邮政 EMS。", 400);
  }
  if (!isJapanPostTrackingNumber(shipment.tracking_number)) {
    throw new TrackingSyncError("该物流批次没有有效的日本邮政 EMS 单号。", 400);
  }

  const runId = createId();
  await store.startRun({
    runId,
    portfolioId: shipment.portfolio_id,
    shipmentId: shipment.id,
    userId,
    startedAt: now().toISOString(),
  });

  let providerResult: Awaited<ReturnType<TrackingFetcher>>;
  try {
    providerResult = await fetchTracking(shipment.tracking_number!);
  } catch (error) {
    const message = errorMessage(error);
    await store.failRun({ runId, finishedAt: now().toISOString(), message });
    throw new TrackingSyncError(message, 502);
  }

  try {
    const events = await eventsForPersistence(providerResult.trackingNumber, providerResult.events);
    const result = await store.completeRun({
      runId,
      shipmentId: shipment.id,
      finishedAt: now().toISOString(),
      events,
    });
    const state = deriveJapanPostShipmentState(providerResult.events);
    return { ...result, latest: providerResult.events.at(-1)!, state };
  } catch (error) {
    const message = errorMessage(error);
    await store.failRun({ runId, finishedAt: now().toISOString(), message }).catch(() => undefined);
    if (error instanceof TrackingSyncError) throw error;
    throw new TrackingSyncError(`物流同步写入失败：${message}`, 500);
  }
}

function databaseMessage(error: { message?: string } | null) {
  return error?.message || "Supabase tracking operation failed.";
}

export function createSupabaseTrackingStore(supabase: SupabaseClient): TrackingSyncStore {
  return {
    async getShipment(shipmentId) {
      const { data, error } = await supabase
        .from("shipments")
        .select("id,portfolio_id,carrier,tracking_number,status")
        .eq("id", shipmentId)
        .maybeSingle();
      if (error) throw new TrackingSyncError(databaseMessage(error), 500);
      return data as TrackingShipment | null;
    },

    async getRole(portfolioId, userId) {
      const { data, error } = await supabase
        .from("portfolio_members")
        .select("role")
        .eq("portfolio_id", portfolioId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new TrackingSyncError(databaseMessage(error), 500);
      return (data?.role as PortfolioRole | undefined) ?? null;
    },

    async startRun({ runId, portfolioId, shipmentId, userId, startedAt }) {
      const { error } = await supabase.from("tracking_sync_runs").insert({
        id: runId,
        portfolio_id: portfolioId,
        shipment_id: shipmentId,
        started_at: startedAt,
        status: "running",
        events_seen: 0,
        events_inserted: 0,
        created_by: userId,
      });
      if (error) {
        const status = error.code === "42501" ? 403 : 500;
        throw new TrackingSyncError(databaseMessage(error), status);
      }
    },

    async completeRun({ runId, shipmentId, finishedAt, events }) {
      const { data, error } = await supabase.rpc("complete_manual_tracking_sync", {
        p_run_id: runId,
        p_shipment_id: shipmentId,
        p_finished_at: finishedAt,
        p_events: events,
      });
      if (error) {
        const status = error.code === "42501" ? 403 : 500;
        throw new TrackingSyncError(databaseMessage(error), status);
      }
      return data as CompletedSync;
    },

    async failRun({ runId, finishedAt, message }) {
      const { error } = await supabase
        .from("tracking_sync_runs")
        .update({
          finished_at: finishedAt,
          status: "failed",
          events_seen: 0,
          events_inserted: 0,
          error_message: message.slice(0, 1000),
        })
        .eq("id", runId)
        .eq("status", "running");
      if (error) throw new TrackingSyncError(databaseMessage(error), 500);
    },
  };
}

export async function refreshSupabaseShipmentTracking({
  supabase,
  userId,
  shipmentId,
}: {
  supabase: SupabaseClient;
  userId: string;
  shipmentId: string;
}) {
  return runManualTrackingSync({
    store: createSupabaseTrackingStore(supabase),
    userId,
    shipmentId,
  });
}
