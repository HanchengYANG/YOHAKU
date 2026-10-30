export const installChoiceCookie = "yohaku_pwa_choice";
const choices = new Set(["later", "ios", "accepted", "dismissed"]);

export function installChoiceScope(session, now = Date.now()) {
  if (!session) return null;
  if (!session.user) return { id: "guest", expiresAt: null };
  const { startedAt, expiresAt } = session.loginSession || {};
  if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= now) return { id: "guest", expiresAt: null };
  return { id: `${session.user.id}:${startedAt}`, expiresAt };
}

function readChoice(header) {
  const value = header.split(";").map(part => part.trim()).find(part => part.startsWith(`${installChoiceCookie}=`));
  if (!value) return null;
  try {
    const record = JSON.parse(decodeURIComponent(value.slice(installChoiceCookie.length + 1)));
    return typeof record.scope === "string" && choices.has(record.choice) ? record : null;
  } catch {
    return null;
  }
}

// The fallback only lasts for this page when cookies are unavailable. Matching
// choices are never rewritten, so refreshes cannot extend the login deadline.
export function createInstallChoices({ getCookie, setCookie, readLegacy = () => false, removeLegacy = () => {}, secure = false, now = Date.now }) {
  let fallback = null;
  let current = null;
  let legacyChecked = false;
  const write = value => { try { setCookie(value); } catch {} };
  const persist = choice => {
    fallback = { scope: current.id, choice };
    const expiry = current.expiresAt ? `; Expires=${new Date(current.expiresAt).toUTCString()}` : "";
    write(`${installChoiceCookie}=${encodeURIComponent(JSON.stringify(fallback))}; Path=/; SameSite=Strict${expiry}${secure ? "; Secure" : ""}`);
  };
  const snapshot = () => ({ scope: current?.id || null, decided: !!fallback && fallback.scope === current?.id });
  return {
    sync(session) {
      current = installChoiceScope(session, now());
      if (!current) return snapshot();
      let stored;
      try { stored = readChoice(getCookie()); } catch {}
      fallback = stored || fallback;
      if (fallback?.scope === "guest" && current.id !== "guest") persist(fallback.choice);
      else if (fallback && fallback.scope !== current.id) {
        fallback = null;
        write(`${installChoiceCookie}=; Path=/; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`);
      }
      if (!legacyChecked) {
        legacyChecked = true;
        let dismissed = false;
        try { dismissed = readLegacy(); } catch {}
        if (dismissed) {
          if (!fallback) persist("ios");
          try { removeLegacy(); } catch {}
        }
      }
      return snapshot();
    },
    choose(choice, expectedScope = current?.id) {
      if (current && current.id === expectedScope && choices.has(choice)) persist(choice);
      return snapshot();
    },
  };
}
