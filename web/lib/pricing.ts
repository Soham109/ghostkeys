import data from "@/content/features.json";

export type Cell = boolean | string;
export type Feature = { id: string; title: string; description: string; free: Cell; pro: Cell; teams: Cell; badge?: "beta" | "soon" };
export type Group = { name: string; features: Feature[] };
export type Tier = {
  id: "free" | "pro" | "teams";
  name: string;
  price: number;
  currency: string;
  billing: string;
  tagline: string;
  cta: string;
  updatesMonths?: number;
  renewalPrice?: number;
  lifetimeUpdatesPrice?: number;
  studentPrice?: number;
  launchPrice?: number;
  launchDays?: number;
  foundingSeats?: number;
  foundingPerk?: string;
  minSeats?: number;
  volumeDiscount?: { fromSeats: number; percentOff: number };
};

export const PRICING = data as unknown as { version: number; updated: string; tiers: Tier[]; badges: Record<string, string>; groups: Group[] };

const all = PRICING.groups.flatMap((g) => g.features);
export const featureById = (id: string) => all.find((f) => f.id === id);

/** "Free", "Pro", "Pro, beta", from the lowest tier that includes every listed feature. */
export function tierLabel(ids: string[]) {
  const fs = ids.map(featureById).filter(Boolean) as Feature[];
  const free = fs.length > 0 && fs.every((f) => f.free !== false);
  const beta = fs.some((f) => f.badge === "beta");
  const soon = fs.some((f) => f.badge === "soon");
  return [free ? "Free" : "Pro", beta ? "beta" : soon ? "soon" : ""].filter(Boolean).join(", ");
}
