"use client";

import { useCallback, useEffect, useState } from "react";

type WebhookStatus =
  | "pending"
  | "processing"
  | "retry_scheduled"
  | "succeeded"
  | "permanently_failed";

interface WebhookEvent {
  id: string;
  event_id: string;
  type: string;
  data: Record<string, unknown>;
  status: WebhookStatus;
  attempt_count: number;
  cycle_attempt_count: number;
  next_attempt_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface ProcessingAttempt {
  id: string;
  event_id: string;
  attempt_number: number;
  worker_id: string;
  started_at: string;
  finished_at: string | null;
  result: "running" | "succeeded" | "failed" | "interrupted";
  error: string | null;
}

const statusColors: Record<string, string> = {
  pending: "bg-slate-100 text-slate-700",
  processing: "bg-blue-100 text-blue-700",
  retry_scheduled: "bg-amber-100 text-amber-700",
  succeeded: "bg-green-100 text-green-700",
  permanently_failed: "bg-red-100 text-red-700",
  running: "bg-blue-100 text-blue-700",
  failed: "bg-red-100 text-red-700",
  interrupted: "bg-orange-100 text-orange-700",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${
        statusColors[status] || "bg-gray-100 text-gray-700"
      }`}
    >
      {status.replaceAll("_", " ")}
    </span>
  );
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "—";
}

async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    cache: "no-store",
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);

    throw new Error(body?.message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export default function Dashboard() {
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [attempts, setAttempts] = useState<ProcessingAttempt[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [attemptsLoading, setAttemptsLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  const [error, setError] = useState("");
  const [attemptError, setAttemptError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchEvents = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await apiRequest<WebhookEvent[]>("/webhooks", { signal });

      if (signal?.aborted) return;

      setEvents(result);
      setLastUpdated(new Date());
      setError("");
    } catch (err) {
      if (signal?.aborted) return;

      setError(err instanceof Error ? err.message : "Unable to load events");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  // Automatically refresh webhook events
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      await fetchEvents(controller.signal);

      if (!controller.signal.aborted) {
        timer = setTimeout(poll, 3000);
      }
    }

    void poll();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [fetchEvents]);

  // Automatically refresh selected event attempt history
  useEffect(() => {
    if (!selectedId) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function pollAttempts() {
      try {
        const result = await apiRequest<ProcessingAttempt[]>(
          `/webhooks/${encodeURIComponent(selectedId!)}/attempts`,
          { signal: controller.signal },
        );

        if (!controller.signal.aborted) {
          setAttempts(result);
          setAttemptError("");
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setAttemptError(
            err instanceof Error ? err.message : "Unable to load attempts",
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setAttemptsLoading(false);
          timer = setTimeout(pollAttempts, 3000);
        }
      }
    }

    void pollAttempts();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [selectedId]);

  function selectEvent(eventId: string) {
    if (selectedId === eventId) return;

    setAttempts([]);
    setAttemptError("");
    setAttemptsLoading(true);
    setSelectedId(eventId);
  }

  async function retryEvent(eventId: string) {
    setRetrying(eventId);
    setActionMessage("");
    setActionError("");

    try {
      await apiRequest(`/webhooks/${encodeURIComponent(eventId)}/retry`, {
        method: "POST",
      });

      setActionMessage(`${eventId} queued for retry successfully`);

      await fetchEvents();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(null);
    }
  }

  const selectedEvent = events.find((event) => event.event_id === selectedId);

  const filteredEvents = events.filter((event) => {
    const matchesStatus = filter === "all" || event.status === filter;

    const matchesSearch = [
      event.event_id,
      event.type,
      String(event.data.orderId ?? ""),
    ].some((value) => value.toLowerCase().includes(search.toLowerCase()));

    return matchesStatus && matchesSearch;
  });

  const stats = [
    {
      label: "Total Events",
      value: events.length,
      color: "text-slate-900",
    },
    {
      label: "Pending",
      value: events.filter((e) => e.status === "pending").length,
      color: "text-slate-600",
    },
    {
      label: "Processing",
      value: events.filter((e) => e.status === "processing").length,
      color: "text-blue-600",
    },
    {
      label: "Scheduled Retries",
      value: events.filter((e) => e.status === "retry_scheduled").length,
      color: "text-amber-600",
    },
    {
      label: "Succeeded",
      value: events.filter((e) => e.status === "succeeded").length,
      color: "text-green-600",
    },
    {
      label: "Failed",
      value: events.filter((e) => e.status === "permanently_failed").length,
      color: "text-red-600",
    },
  ];

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      {/* Header */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-400 flex-wrap items-center justify-between gap-4 px-6 py-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">
              Surpluss Assessment
            </p>

            <h1 className="mt-1 text-2xl font-bold">Webhook Operations</h1>

            <p className="mt-1 text-sm text-slate-500">
              Monitor events, processing attempts and retries.
            </p>
          </div>

          <div className="text-right">
            <div className="flex items-center justify-end gap-2 text-sm">
              <span
                className={`h-2 w-2 rounded-full ${
                  loading
                    ? "bg-amber-500"
                    : error
                      ? "bg-red-500"
                      : "bg-green-500"
                }`}
              />

              {loading
                ? "Connecting"
                : error
                  ? "Disconnected"
                  : "Live monitoring"}
            </div>

            <p className="mt-1 text-xs text-slate-500">
              {lastUpdated
                ? `Updated ${lastUpdated.toLocaleTimeString()}`
                : "Waiting for data"}
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-400 space-y-6 p-6">
        {/* Error and action messages */}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {actionError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {actionError}
          </div>
        )}

        {actionMessage && (
          <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-700">
            {actionMessage}
          </div>
        )}

        {/* Statistics */}
        <section className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-xl border border-slate-200 bg-white p-5"
            >
              <p className="text-sm text-slate-500">{stat.label}</p>

              <p className={`mt-2 text-3xl font-bold ${stat.color}`}>
                {loading ? "—" : stat.value}
              </p>
            </div>
          ))}
        </section>

        {/* Events table */}
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 p-5">
            <div>
              <h2 className="text-lg font-semibold">Received Events</h2>

              <p className="text-sm text-slate-500">
                {filteredEvents.length} of {events.length} events
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <input
                type="search"
                placeholder="Search events..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />

              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="all">All statuses</option>
                <option value="pending">Pending</option>
                <option value="processing">Processing</option>
                <option value="retry_scheduled">Retry scheduled</option>
                <option value="succeeded">Succeeded</option>
                <option value="permanently_failed">Permanently failed</option>
              </select>

              <button
                onClick={() => void fetchEvents()}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  {[
                    "Event ID",
                    "Type",
                    "Order ID",
                    "Status",
                    "Attempts",
                    "Worker",
                    "Received At",
                    "Actions",
                  ].map((heading) => (
                    <th key={heading} className="px-5 py-4 font-medium">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {filteredEvents.map((event) => (
                  <tr
                    key={event.id}
                    className={
                      selectedId === event.event_id
                        ? "bg-blue-50"
                        : "hover:bg-slate-50"
                    }
                  >
                    <td className="px-5 py-4 font-medium">{event.event_id}</td>

                    <td className="px-5 py-4">{event.type}</td>

                    <td className="px-5 py-4">
                      {String(event.data.orderId ?? "—")}
                    </td>

                    <td className="px-5 py-4">
                      <StatusBadge status={event.status} />
                    </td>

                    <td className="px-5 py-4">{event.attempt_count}</td>

                    <td className="px-5 py-4">{event.claimed_by ?? "—"}</td>

                    <td className="px-5 py-4">
                      {formatDate(event.created_at)}
                    </td>

                    <td className="px-5 py-4">
                      <div className="flex gap-2">
                        <button
                          onClick={() => selectEvent(event.event_id)}
                          className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100"
                        >
                          Details
                        </button>

                        {event.status === "permanently_failed" && (
                          <button
                            disabled={retrying !== null}
                            onClick={() => void retryEvent(event.event_id)}
                            className="rounded-md bg-blue-600 px-3 py-1.5 text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            {retrying === event.event_id
                              ? "Retrying..."
                              : "Retry"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}

                {filteredEvents.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-10 text-center text-slate-500">
                      {loading ? "Loading events..." : "No events found"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Selected event details */}
        {selectedEvent && (
          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 p-5">
              <div>
                <h2 className="text-lg font-semibold">Event Details</h2>

                <p className="text-sm text-slate-500">
                  {selectedEvent.event_id}
                </p>
              </div>

              <button
                onClick={() => setSelectedId(null)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100"
              >
                Close
              </button>
            </div>

            <div className="grid gap-6 p-5 lg:grid-cols-2">
              <div className="space-y-4">
                <h3 className="font-semibold">Event Information</h3>

                <dl className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <dt className="text-slate-500">Status</dt>
                    <dd className="mt-1">
                      <StatusBadge status={selectedEvent.status} />
                    </dd>
                  </div>

                  <div>
                    <dt className="text-slate-500">Total Attempts</dt>
                    <dd className="mt-1 font-medium">
                      {selectedEvent.attempt_count}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-slate-500">Current Cycle Attempts</dt>
                    <dd className="mt-1 font-medium">
                      {selectedEvent.cycle_attempt_count}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-slate-500">Current Worker</dt>
                    <dd className="mt-1 font-medium">
                      {selectedEvent.claimed_by ?? "—"}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-slate-500">Received At</dt>
                    <dd className="mt-1">
                      {formatDate(selectedEvent.created_at)}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-slate-500">Last Updated</dt>
                    <dd className="mt-1">
                      {formatDate(selectedEvent.updated_at)}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-slate-500">Next Attempt</dt>
                    <dd className="mt-1">
                      {["pending", "retry_scheduled"].includes(
                        selectedEvent.status,
                      )
                        ? formatDate(selectedEvent.next_attempt_at)
                        : "—"}
                    </dd>
                  </div>
                </dl>

                {selectedEvent.last_error && (
                  <div className="rounded-lg bg-red-50 p-4 text-sm text-red-700">
                    <p className="mb-1 font-semibold">Last Error</p>
                    {selectedEvent.last_error}
                  </div>
                )}
              </div>

              <div>
                <h3 className="mb-3 font-semibold">Webhook Payload</h3>

                <pre className="max-h-80 overflow-auto rounded-lg bg-slate-900 p-4 text-xs leading-relaxed text-slate-100">
                  {JSON.stringify(
                    {
                      eventId: selectedEvent.event_id,
                      type: selectedEvent.type,
                      data: selectedEvent.data,
                    },
                    null,
                    2,
                  )}
                </pre>
              </div>
            </div>

            {/* Attempt history */}
            <div className="border-t border-slate-200 p-5">
              <h3 className="mb-4 font-semibold">Attempt History</h3>

              {attemptError && (
                <p className="mb-3 text-sm text-red-600">{attemptError}</p>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                    <tr>
                      {[
                        "Attempt",
                        "Worker",
                        "Started At",
                        "Finished At",
                        "Result",
                        "Error",
                      ].map((heading) => (
                        <th key={heading} className="px-4 py-3 font-medium">
                          {heading}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody className="divide-y divide-slate-100">
                    {attempts.map((attempt) => (
                      <tr key={attempt.id}>
                        <td className="px-4 py-4 font-medium">
                          #{attempt.attempt_number}
                        </td>

                        <td className="px-4 py-4">{attempt.worker_id}</td>

                        <td className="whitespace-nowrap px-4 py-4">
                          {formatDate(attempt.started_at)}
                        </td>

                        <td className="whitespace-nowrap px-4 py-4">
                          {formatDate(attempt.finished_at)}
                        </td>

                        <td className="px-4 py-4">
                          <StatusBadge status={attempt.result} />
                        </td>

                        <td className="min-w-48 px-4 py-4 text-xs text-red-600">
                          {attempt.error ?? "—"}
                        </td>
                      </tr>
                    ))}

                    {attempts.length === 0 && (
                      <tr>
                        <td
                          colSpan={6}
                          className="p-6 text-center text-slate-500"
                        >
                          {attemptsLoading
                            ? "Loading attempts..."
                            : "No processing attempts yet"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        <footer className="py-3 text-center text-xs text-slate-500">
          Reliable Webhook Processor · Auto-refresh every 3 seconds
        </footer>
      </div>
    </main>
  );
}
