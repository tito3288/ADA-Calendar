import type { Client } from "./types";

const clientNames = new Intl.Collator("en", { sensitivity: "base", numeric: true });

export function sortClientsByName(clients: readonly Client[]): Client[] {
  return [...clients].sort((a, b) => clientNames.compare(a.name.trim(), b.name.trim()));
}
