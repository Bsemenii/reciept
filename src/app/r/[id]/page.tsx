import { Suspense } from "react";
import ReceiptView from "./receipt-view";

// The receipt id is only known at request time, so the client view renders inside Suspense.
export default function ReceiptPage() {
  return (
    <Suspense fallback={<main className="p-6">Loading…</main>}>
      <ReceiptView />
    </Suspense>
  );
}
