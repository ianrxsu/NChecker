"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import {
  Check,
  Loader2,
  Save,
  SlidersHorizontal,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Service = "netflix" | "prime" | "crunchyroll";
type Window = "hour" | "day";
type Limits = Record<Service, number>;
type Windows = Record<Service, Window>;
type Code = {
  id: number;
  code: string;
  durationHours: number;
  expiresAt: string | null;
  accessType: "lifetime" | "temporary";
  status: "Revoked" | "Expired" | "Redeemed" | "Unused";
  active: boolean;
  boundDeviceId: string | null;
  netflixLimit: number | null;
  primeLimit: number | null;
  crunchyrollLimit: number | null;
  netflixWindow: Window | null;
  primeWindow: Window | null;
  crunchyrollWindow: Window | null;
};
const services: Array<{ key: Service; label: string }> = [
  { key: "netflix", label: "Netflix" },
  { key: "prime", label: "Amazon Prime" },
  { key: "crunchyroll", label: "Crunchyroll" },
];
const emptyLimits: Limits = { netflix: 5, prime: 5, crunchyroll: 5 };
const emptyWindows: Windows = {
  netflix: "day",
  prime: "day",
  crunchyroll: "day",
};

export function AccessCodesSection() {
  const { data: codes = [], error: loadError, mutate: load } = useSWR<Code[]>(
    "/api/admin/access-codes",
    async (url: string) => {
      const res = await fetch(url, { cache: "no-store" });
      const data = await res.json().catch(() => []);
      if (!res.ok) throw new Error(data?.error ?? "Unable to load access codes");
      return data;
    },
    {
      refreshInterval: 300_000,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
      focusThrottleInterval: 300_000,
      dedupingInterval: 30_000,
      errorRetryCount: 2,
    },
  );
  const [code, setCode] = useState("");
  const [accessType, setAccessType] = useState<"lifetime" | "temporary">(
    "lifetime",
  );
  const [limits, setLimits] = useState<Limits>(emptyLimits);
  const [windows, setWindows] = useState<Windows>(emptyWindows);
  const [editing, setEditing] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<
    Record<number, { limits: Limits; windows: Windows }>
  >({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  useEffect(() => {
    if (loadError) setMessage({ text: loadError.message, error: true });
  }, [loadError]);
  async function request(
    action: "create" | "revoke" | "activate" | "unbind" | "delete" | "limits",
    id?: number,
    nextLimits?: Limits,
    nextWindows?: Windows,
  ) {
    const key = `${action}-${id ?? "new"}`;
    setBusy(key);
    setMessage(null);
    try {
      const payload =
        action === "create"
          ? { code: code.trim(), accessType, limits, windows }
          : { id, action, limits: nextLimits, windows: nextWindows };
      const res = await fetch("/api/admin/access-codes", {
        method: action === "create" ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Action failed");
      setMessage({
        text:
          action === "create"
            ? accessType === "temporary"
              ? "24-hour free access code created."
              : "Lifetime access code created."
            : action === "unbind"
              ? "Device logged out and lifetime access revoked. The code is ready to bind again."
              : "Changes saved.",
      });
      if (action === "create") {
        setCode("");
        setAccessType("lifetime");
        setLimits(emptyLimits);
        setWindows(emptyWindows);
      }
      await load();
    } catch (e) {
      setMessage({
        text: e instanceof Error ? e.message : "Action failed",
        error: true,
      });
    } finally {
      setBusy(null);
    }
  }
  function startEdit(item: Code) {
    setEditing(item.id);
    setDrafts((d) => ({
      ...d,
      [item.id]: {
        limits: {
          netflix: item.netflixLimit ?? 1,
          prime: item.primeLimit ?? 1,
          crunchyroll: item.crunchyrollLimit ?? 1,
        },
        windows: {
          netflix: item.netflixWindow ?? "day",
          prime: item.primeWindow ?? "day",
          crunchyroll: item.crunchyrollWindow ?? "day",
        },
      },
    }));
  }
  const isBusy = (a: string, id?: number) => busy === `${a}-${id ?? "new"}`;
  const fields = (
    values: Limits,
    setValues: (v: Limits) => void,
    ws: Windows,
    setWs: (v: Windows) => void,
    disabled = false,
  ) =>
    services.map(({ key, label }) => (
      <div key={key} className="flex min-w-0 items-center gap-2">
        <input
          disabled={disabled}
          aria-label={`${label} account limit`}
          type="number"
          min="1"
          max="100000"
          value={values[key]}
          onChange={(e) =>
            setValues({
              ...values,
              [key]: Math.max(1, Number(e.target.value) || 1),
            })
          }
          className="min-h-10 w-24 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50 focus:ring-2 focus:ring-ring"
        />
        <select
          disabled={disabled}
          aria-label={`${label} limit window`}
          value={ws[key]}
          onChange={(e) => setWs({ ...ws, [key]: e.target.value as Window })}
          className="min-h-10 rounded-md border border-border bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="hour">per hour</option>
          <option value="day">per day</option>
        </select>
      </div>
    ));
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">
          Access code inventory
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure each service&apos;s account limit and whether it resets per
          hour or per day.
        </p>
      </div>
      <div className="grid gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_repeat(3,auto)_auto]">
        {" "}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={
            accessType === "temporary"
              ? "ABCD1234 → CMF-ABCD1234"
              : "ABCD1234 → CML-ABCD1234"
          }
          aria-label="New access code"
          className="min-h-10 min-w-0 rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <select
          value={accessType}
          onChange={(e) =>
            setAccessType(e.target.value as "lifetime" | "temporary")
          }
          aria-label="Access code type"
          className="min-h-10 rounded-md border border-border bg-background px-2 text-sm"
        >
          <option value="lifetime">Lifetime key</option>
          <option value="temporary">24-hour free key</option>
        </select>
        {fields(
          limits,
          setLimits,
          windows,
          setWindows,
          accessType === "temporary",
        )}
        <Button disabled={busy !== null} onClick={() => void request("create")}>
          {code.trim() ? "Create code" : "Generate code"}
        </Button>
      </div>
      {message && (
        <div
          role="status"
          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${message.error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"}`}
        >
          {message.error ? (
            <X className="size-4" />
          ) : (
            <Check className="size-4" />
          )}
          {message.text}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <div role="table" aria-label="Access code inventory" className="min-w-[980px]">
          <div role="row" className="grid grid-cols-[1.5fr_1fr_1fr_1.5fr_2.4fr] gap-4 border-b border-border bg-muted/50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span role="columnheader">Key</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Status</span>
            <span role="columnheader">Binding</span>
            <span role="columnheader">Actions</span>
          </div>
        {codes.map((item) => {
          const draft = drafts[item.id] ?? {
            limits: {
              netflix: item.netflixLimit ?? 1,
              prime: item.primeLimit ?? 1,
              crunchyroll: item.crunchyrollLimit ?? 1,
            },
            windows: {
              netflix: item.netflixWindow ?? "day",
              prime: item.primeWindow ?? "day",
              crunchyroll: item.crunchyrollWindow ?? "day",
            },
          };
          return (
            <div
              key={item.id}
              className="border-b border-border last:border-b-0"
              role="row"
            >
              <div className="grid grid-cols-[1.5fr_1fr_1fr_1.5fr_2.4fr] items-center gap-4 p-4">
                <code className="font-mono font-semibold">{item.code}</code>
                <span className="text-sm font-medium">
                  {item.accessType === "temporary" ? "24-hour free" : "Lifetime"}
                </span>
                <span className="text-sm">{item.status}</span>
                <span className="text-xs text-muted-foreground">
                  {item.boundDeviceId ? "Bound" : "Unbound"}
                  {item.accessType === "temporary" && item.expiresAt
                    ? ` · expires ${new Date(item.expiresAt).toLocaleString()}`
                    : item.accessType === "lifetime"
                      ? ` · N:${item.netflixLimit}/${item.netflixWindow} · P:${item.primeLimit}/${item.primeWindow} · C:${item.crunchyrollLimit}/${item.crunchyrollWindow}`
                      : ""}
                </span>
                <div className="ml-auto flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      void request(item.active ? "revoke" : "activate", item.id)
                    }
                  >
                    {item.active ? "Revoke" : "Activate"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => startEdit(item)}
                    disabled={item.accessType === "temporary"}
                    className={
                      item.accessType === "temporary" ? "hidden" : undefined
                    }
                  >
                    <SlidersHorizontal className="mr-1 size-3" />
                    Limits
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!item.boundDeviceId || busy !== null}
                    onClick={() => void request("unbind", item.id)}
                  >
                    <Unlink className="mr-1 size-3" />
                    Unbind & revoke
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy !== null}
                    onClick={() =>
                      window.confirm(`Delete ${item.code}?`) &&
                      void request("delete", item.id)
                    }
                  >
                    <Trash2 className="mr-1 size-3" />
                    Delete
                  </Button>
                </div>
              </div>
              {editing === item.id && (
                <div className="border-t border-border bg-muted/40 p-4">
                  <div className="mb-4 flex items-center gap-2">
                    <SlidersHorizontal className="size-4" />
                    <h3 className="font-semibold">Account generation limits</h3>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {services.map(({ key, label }) => (
                      <label
                        key={key}
                        className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-sm font-medium"
                      >
                        {label}
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="1"
                            max="100000"
                            value={draft.limits[key]}
                            onChange={(e) =>
                              setDrafts({
                                ...drafts,
                                [item.id]: {
                                  ...draft,
                                  limits: {
                                    ...draft.limits,
                                    [key]: Math.max(
                                      1,
                                      Number(e.target.value) || 1,
                                    ),
                                  },
                                },
                              })
                            }
                            className="min-h-10 w-24 rounded-md border border-border bg-background px-3"
                          />
                          <select
                            value={draft.windows[key]}
                            onChange={(e) =>
                              setDrafts({
                                ...drafts,
                                [item.id]: {
                                  ...draft,
                                  windows: {
                                    ...draft.windows,
                                    [key]: e.target.value as Window,
                                  },
                                },
                              })
                            }
                            className="min-h-10 rounded-md border border-border bg-background px-2"
                          >
                            <option value="hour">per hour</option>
                            <option value="day">per day</option>
                          </select>
                        </div>
                      </label>
                    ))}
                  </div>
                  <div className="mt-4 flex justify-end">
                    <Button
                      disabled={busy !== null}
                      onClick={() =>
                        void request(
                          "limits",
                          item.id,
                          draft.limits,
                          draft.windows,
                        )
                      }
                    >
                      {isBusy("limits", item.id) ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <Save className="mr-2 size-4" />
                      )}
                      Save limits
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        </div>
      </div>
    </section>
  );
}
