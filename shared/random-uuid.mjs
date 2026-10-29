// crypto.randomUUID is only available in secure contexts (HTTPS or localhost).
// Over plain HTTP on a LAN the phone loads the page from a non-secure context,
// so fall back to crypto.getRandomValues, which is available everywhere.
export function randomUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-` +
    `${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-` +
    hex.slice(10, 16).join("");
}
