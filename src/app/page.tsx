"use client";

// Payer flow: photo -> check items -> name + phone -> link.
// Functional skeleton only; styling and animations belong to the frontend owner.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import demo from "@/fixtures/demo-receipt.json";
import { createReceipt } from "@/lib/db";
import { getPayer, savePayer, savePerson } from "@/lib/identity";
import { errorCode, errorText } from "@/lib/errors";
import { compressImage } from "@/lib/image";
import { checksumDiff, formatMoney } from "@/lib/split";
import type { Receipt } from "@/lib/types";

type Draft = Omit<Receipt, "id" | "payer_name" | "payer_phone" | "created_at">;

export default function ScanPage() {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => {
    // localStorage only exists after hydration, so this has to run in an effect
    const payer = getPayer();
    if (payer) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setName(payer.name);
      setPhone(payer.phone);
    }
    // ?demo=1 skips the model: the backup for bad Wi-Fi or a bad photo on stage
    if (new URLSearchParams(window.location.search).has("demo")) setDraft(demo as Draft);
  }, []);

  async function onPhoto(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const image = await compressImage(file);
      const res = await fetch("/api/parse", { method: "POST", body: JSON.stringify({ image }) });
      const data = await res.json().catch(() => ({}));
      // No error code = the proxy couldn't reach the backend
      if (!res.ok) throw new Error(data.error ?? "network");
      setDraft(data.receipt);
    } catch (e) {
      setError(errorCode(e));
    } finally {
      setBusy(false);
    }
  }

  async function onCreate() {
    if (!draft || !name.trim()) return;
    setBusy(true);
    try {
      savePayer({ name: name.trim(), phone: phone.trim() });
      savePerson(name);
      const id = await createReceipt({ ...draft, payer_name: name.trim(), payer_phone: phone.trim() });
      router.push(`/r/${id}`);
    } catch (e) {
      setError(errorCode(e));
      setBusy(false);
    }
  }

  function editPrice(id: string) {
    if (!draft) return;
    const item = draft.items.find((i) => i.id === id)!;
    const input = prompt(item.display_name, (item.price_cents / 100).toFixed(2).replace(".", ","));
    const cents = input ? Math.round(parseFloat(input.replace(",", ".")) * 100) : NaN;
    if (!Number.isFinite(cents)) return;
    setDraft({ ...draft, items: draft.items.map((i) => (i.id === id ? { ...i, price_cents: cents } : i)) });
  }

  if (!draft) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-6 p-6">
        <label className="flex h-48 w-full cursor-pointer items-center justify-center rounded-3xl bg-black text-xl font-semibold text-white">
          {busy ? "Reading receipt…" : "📸 Scan receipt"}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            disabled={busy}
            onChange={(e) => onPhoto(e.target.files?.[0])}
          />
        </label>
        {error && <p className="text-red-600">{errorText(error)}</p>}
      </main>
    );
  }

  const diff = checksumDiff({ ...draft, id: "", payer_name: "", payer_phone: "" });

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-6">
      <ul className="divide-y">
        {draft.items.map((item) => (
          <li key={item.id} className="flex justify-between py-3" onClick={() => editPrice(item.id)}>
            <span>{item.display_name}</span>
            <span className="tabular-nums">{formatMoney(item.price_cents, draft.currency)}</span>
          </li>
        ))}
      </ul>
      <p className={diff === 0 ? "text-green-700" : "text-amber-600"}>
        {diff === 0
          ? `✓ Adds up to ${formatMoney(draft.total_cents, draft.currency)}`
          : `Off by ${formatMoney(Math.abs(diff), draft.currency)} — tap a price to fix it`}
      </p>
      <input className="rounded-xl border p-3" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
      <input
        className="rounded-xl border p-3"
        placeholder="Phone for BLIK"
        inputMode="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      <button className="rounded-2xl bg-black p-4 font-semibold text-white disabled:opacity-40" disabled={busy || !name.trim()} onClick={onCreate}>
        Get link
      </button>
      {error && <p className="text-red-600">{errorText(error)}</p>}
    </main>
  );
}
