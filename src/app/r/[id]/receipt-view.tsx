"use client";

// Friend flow: name -> tap your items -> see what you owe -> copy phone.
// Functional skeleton only; styling and animations belong to the frontend owner.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getReceipt, setClaim, subscribeReceipt } from "@/lib/db";
import { errorCode, errorText } from "@/lib/errors";
import { getPerson, savePerson } from "@/lib/identity";
import { computeSplit, formatMoney } from "@/lib/split";
import type { Claim, Person, Receipt } from "@/lib/types";

const claimKey = (c: Pick<Claim, "item_id" | "person_id">) => `${c.item_id}:${c.person_id}`;

export default function ReceiptView() {
  const { id } = useParams<{ id: string }>();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [claims, setClaims] = useState<Record<string, Claim>>({});
  const [me, setMe] = useState<Person | null>(null);
  const [online, setOnline] = useState<Person[]>([]);
  const [name, setName] = useState("");
  const [done, setDone] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // localStorage only exists after hydration, so this has to run in an effect
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMe(getPerson());
    getReceipt(id)
      .then((r) => {
        if (!r) return setLoadError("not_found");
        setReceipt(r.receipt);
        setClaims(Object.fromEntries(r.claims.map((c) => [claimKey(c), c])));
      })
      .catch((e) => setLoadError(errorCode(e)));
  }, [id]);

  useEffect(() => {
    if (!me) return;
    return subscribeReceipt(
      id,
      me,
      (c) => setClaims((prev) => ({ ...prev, [claimKey(c)]: c })),
      setOnline,
    );
  }, [id, me]);

  const claimList = useMemo(() => Object.values(claims), [claims]);
  const split = useMemo(() => (receipt ? computeSplit(receipt, claimList) : null), [receipt, claimList]);

  // People already on this receipt, so someone in a different browser can rejoin as themselves.
  const known = useMemo(() => {
    const byId = new Map<string, Person>();
    for (const c of claimList) byId.set(c.person_id, { id: c.person_id, name: c.person_name, color: c.color });
    return [...byId.values()];
  }, [claimList]);

  async function toggle(itemId: string) {
    if (!me) return;
    const key = claimKey({ item_id: itemId, person_id: me.id });
    const active = !claims[key]?.active;
    const optimistic: Claim = { receipt_id: id, item_id: itemId, person_id: me.id, person_name: me.name, color: me.color, active };
    setClaims((prev) => ({ ...prev, [key]: optimistic }));
    try {
      await setClaim(id, itemId, me, active);
    } catch {
      setClaims((prev) => ({ ...prev, [key]: { ...optimistic, active: !active } }));
    }
  }

  if (loadError) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6 text-center">
        <p className="text-lg">{errorText(loadError)}</p>
        {loadError === "not_found" ? (
          <Link className="rounded-2xl bg-black p-4 font-semibold text-white" href="/">
            Scan a receipt
          </Link>
        ) : (
          <button className="rounded-2xl bg-black p-4 font-semibold text-white" onClick={() => window.location.reload()}>
            Try again
          </button>
        )}
      </main>
    );
  }

  if (!receipt) return <main className="p-6">Loading…</main>;

  if (!me) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-2xl font-semibold">{receipt.payer_name} paid. What&apos;s your name?</h1>
        {known.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {known.map((p) => (
              <button key={p.id} className="rounded-full border px-4 py-2" onClick={() => setMe(savePerson(p.name, p))}>
                I&apos;m {p.name}
              </button>
            ))}
          </div>
        )}
        <input className="rounded-xl border p-3" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="rounded-2xl bg-black p-4 font-semibold text-white disabled:opacity-40" disabled={!name.trim()} onClick={() => setMe(savePerson(name))}>
          Continue
        </button>
      </main>
    );
  }

  const mine = split?.perPerson[me.id] ?? 0;

  if (done) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6 text-center">
        <p className="text-lg">You owe {receipt.payer_name}</p>
        <p className="text-5xl font-bold tabular-nums">{formatMoney(mine, receipt.currency)}</p>
        {receipt.payer_phone && (
          <button className="rounded-2xl bg-black p-4 font-semibold text-white" onClick={() => navigator.clipboard.writeText(receipt.payer_phone)}>
            Copy BLIK number {receipt.payer_phone}
          </button>
        )}
        <button className="underline" onClick={() => setDone(false)}>
          Back
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-6 pb-40">
      <div className="flex gap-1">
        {online.map((p) => (
          <span key={p.id} className="rounded-full px-2 py-1 text-xs text-white" style={{ background: p.color }}>
            {p.name}
          </span>
        ))}
      </div>
      <ul className="divide-y">
        {receipt.items.map((item) => {
          const takers = claimList.filter((c) => c.item_id === item.id && c.active);
          const mineToo = takers.some((c) => c.person_id === me.id);
          return (
            <li key={item.id} className="flex items-center justify-between gap-2 py-3" onClick={() => toggle(item.id)}>
              <span className={mineToo ? "font-semibold" : ""}>{item.display_name}</span>
              <span className="flex items-center gap-1">
                {takers.map((c) => (
                  <span key={c.person_id} className="h-3 w-3 rounded-full" style={{ background: c.color }} />
                ))}
                <span className="tabular-nums">{formatMoney(item.price_cents, receipt.currency)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="fixed inset-x-0 bottom-0 mx-auto flex max-w-md flex-col gap-2 bg-white p-6">
        {split && split.unclaimedCents > 0 && (
          <p className="text-sm text-amber-600">
            Nobody took {split.unclaimedItemIds.length} items ({formatMoney(split.unclaimedCents, receipt.currency)})
          </p>
        )}
        <button className="rounded-2xl bg-black p-4 font-semibold text-white" onClick={() => setDone(true)}>
          My share: {formatMoney(mine, receipt.currency)}
        </button>
        <button
          className="text-sm underline"
          onClick={() =>
            navigator.share
              ? navigator.share({ title: "Split the bill", url: window.location.href }).catch(() => {})
              : navigator.clipboard.writeText(window.location.href)
          }
        >
          Send link to friends
        </button>
      </div>
    </main>
  );
}
