/* The leak-check dialog is opened from row menus and the bulk bar, which unmount as soon as
   they're clicked, so the open state lives here and a host that is always mounted renders it. */
let openIds: string[] | null = null;
const listeners = new Set<() => void>();

export const openLeakCheck = (ids: string[] | null) => {
  openIds = ids && ids.length ? ids : null;
  listeners.forEach((l) => l());
};
export const getLeakIds = () => openIds;
export const subscribeLeak = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
