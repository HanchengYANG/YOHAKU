import { useEffect, useState } from "react";

// The browser's deferred install prompt (beforeinstallprompt), shared between
// PWAManager, which receives it, and the account menu, which offers it on
// desktops instead of a banner (§5.4).
let deferred = null;
const listeners = new Set();

export const installPrompt = {
  get: () => deferred,
  set(event) {
    deferred = event;
    for (const listener of listeners) listener(deferred);
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useInstallPrompt() {
  const [event, setEvent] = useState(installPrompt.get);
  useEffect(() => installPrompt.subscribe(setEvent), []);
  return event;
}

// Runs the native prompt once; the event cannot be reused afterwards.
export async function promptInstall(event = deferred) {
  if (!event) return null;
  installPrompt.set(null);
  try {
    await event.prompt();
    return (await event.userChoice)?.outcome || null;
  } catch {
    return null;
  }
}
