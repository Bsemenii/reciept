// Owner: Bohdan (copy). Error codes come from the backend (server/src/app.ts) and src/lib/image.ts.

const TEXTS: Record<string, string> = {
  not_a_receipt: "That doesn't look like a receipt. Try again with the whole receipt in the frame.",
  unreadable: "Couldn't read this receipt. Try a sharper photo in better light.",
  image_unreadable: "Couldn't open this photo. Try taking it again with the camera.",
  encode_failed: "Couldn't open this photo. Try taking it again with the camera.",
  heic_unsupported: "This photo format isn't supported. Take the photo with the camera instead.",
  not_an_image: "That file isn't a photo.",
  image_too_large: "This photo is too large. Try taking it again with the camera.",
  busy: "Too many scans right now. Wait a few seconds and try again.",
  timeout: "Reading the receipt took too long. Try again.",
  model_error: "Couldn't read the receipt right now. Try again in a moment.",
  no_credit: "Receipt reading is paused right now. Enter the items by hand or try again later.",
  invalid_body: "Something in the receipt looks off. Check the prices and try again.",
  not_found: "This receipt doesn't exist or has expired.",
  network: "No connection to the server. Check your internet and try again.",
};

export function errorText(code: string | null | undefined): string {
  return (code && TEXTS[code]) || "Something went wrong. Try again.";
}

/** Error code from anything thrown by fetch/db.ts/image.ts. */
export function errorCode(e: unknown): string {
  if (e instanceof TypeError) return "network"; // fetch throws TypeError when the server is unreachable
  return e instanceof Error ? e.message : "unknown";
}
