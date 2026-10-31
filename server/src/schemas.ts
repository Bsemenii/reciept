import { z } from "zod";

// Request bodies. Money is integer cents; anything else is rejected with 400 invalid_body.

const Cents = z.number().int().min(0).max(10_000_000);

const ItemSchema = z.object({
  id: z.string().min(1).max(32),
  name: z.string().max(200),
  display_name: z.string().max(200),
  price_cents: Cents,
});

export const ParseBodySchema = z.object({
  image: z.string().optional(),
  media_type: z.string().optional(), // ignored: the server sniffs the real format from the bytes
});

export const CreateReceiptSchema = z.object({
  payer_name: z.string().trim().min(1).max(40),
  payer_phone: z.string().trim().max(20).default(""),
  currency: z.string().regex(/^[A-Z]{3}$/).default("PLN"),
  items: z
    .array(ItemSchema)
    .min(1)
    .max(200)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, "item ids must be unique"),
  service_cents: Cents.default(0),
  tip_cents: Cents.default(0),
  discount_cents: Cents.default(0),
  total_cents: Cents,
});

export const PersonSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export const ClaimBodySchema = z.object({
  item_id: z.string().min(1).max(32),
  person: PersonSchema,
  active: z.boolean(),
});
