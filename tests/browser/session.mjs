import { expect } from "@playwright/test";

// Public fixture credentials for isolated browser-test databases only.
export const testOwner = {
  username: "test_owner",
  password: "fixture-only-password",
};

export async function ensureOwnerSession(request) {
  const state = await request.get("/api/session");
  expect(state.status()).toBe(200);
  const session = await state.json();
  if (session.user?.username === testOwner.username) return session.user;
  const response = await request.post(
    session.needsSetup ? "/api/accounts/setup" : "/api/session/login",
    { data: testOwner },
  );
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.user?.username).toBe(testOwner.username);
  return result.user;
}
