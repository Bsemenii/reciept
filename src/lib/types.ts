// Shared contract between UI, API and DB. Change only after the whole team agrees.
// All money is integer cents (grosze). Never use floats for money.

export type Item = {
  id: string; // stable within a receipt, e.g. "i3" or "i3.2" for the 2nd unit of a qty line
  name: string; // as printed on the receipt
  display_name: string; // cleaned-up human name, same language as the receipt
  price_cents: number; // price of THIS row (one unit after qty expansion)
};

export type Receipt = {
  id: string;
  payer_name: string;
  payer_phone: string;
  currency: string; // "PLN"
  items: Item[];
  service_cents: number;
  tip_cents: number;
  discount_cents: number; // positive number, subtracted
  total_cents: number; // the total printed on the receipt
  created_at?: string;
};

export type Person = {
  id: string;
  name: string;
  color: string;
};

export type Claim = {
  receipt_id: string;
  item_id: string;
  person_id: string;
  person_name: string;
  color: string;
  active: boolean;
};
