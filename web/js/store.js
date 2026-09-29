// Session + reference data shared across views, and a tiny event bus.
import { api } from "./api.js";

const bus = new EventTarget();

export function on(type, fn) {
  const handler = (e) => fn(e.detail);
  bus.addEventListener(type, handler);
  return () => bus.removeEventListener(type, handler);
}

export function emit(type, detail) {
  bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export const store = {
  me: null,
  members: [],
  sites: [],
  online: navigator.onLine,
  rev: null,

  get user() {
    return this.me?.user || null;
  },
  has(...roles) {
    const mine = this.me?.user?.roles || [];
    return roles.some((r) => mine.includes(r));
  },
  member(id) {
    return this.members.find((m) => m.id === id) || null;
  },
  /** Active members that own a board column, ordered by slot. */
  slotted() {
    return this.members.filter((m) => m.board_slot).sort((a, b) => a.board_slot - b.board_slot);
  },
  site(id) {
    return this.sites.find((s) => s.id === Number(id)) || null;
  },
};

export async function loadReference() {
  const [team, sites] = await Promise.all([api.get("api/team"), api.get("api/sites")]);
  store.members = team.items;
  store.sites = sites.items;
  emit("reference", null);
}
