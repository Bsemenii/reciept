"use client";

import { nanoid } from "nanoid";
import type { Person } from "./types";

// No accounts: a person is a random id + name in localStorage.
// In-app browsers (Messenger, Instagram, Telegram) have their own storage, so the receipt page
// should also let people re-pick their name from the people already on the receipt.

const PERSON_KEY = "split.person";
const PAYER_KEY = "split.payer";

export const COLORS = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / blocked storage: the app still works for this page view
  }
}

export function getPerson(): Person | null {
  return read<Person>(PERSON_KEY);
}

export function savePerson(name: string, existing?: Person): Person {
  const person: Person = existing ?? {
    id: nanoid(10),
    name: name.trim(),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
  write(PERSON_KEY, person);
  return person;
}

export type Payer = { name: string; phone: string };

export function getPayer(): Payer | null {
  return read<Payer>(PAYER_KEY);
}

export function savePayer(payer: Payer) {
  write(PAYER_KEY, payer);
}
