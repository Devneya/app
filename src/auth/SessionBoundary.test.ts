import { describe, expect, it, vi } from "vitest";
import type { Session } from "@supabase/supabase-js";
import { config } from "@/config";
import { MOCK_USER, mockGoTrueAuthResponse } from "@/mocks/data";
import * as auth from "@/supabase";

const key = `sb-${new URL(config.apiBaseUrl).hostname.split(".")[0]}-auth-token`;
const origin = () => mockGoTrueAuthResponse(MOCK_USER.email) as Session;
function deferred() {
  let release!: () => void;
  let started!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  return { release, started, wait, entered };
}

describe("SDK action session boundary", () => {
  it.each(["same", "other"])("does not remove a newer %s account before its auth event arrives", async account => {
    vi.mocked(auth.createSessionClient).mockRestore();
    const old = origin();
    localStorage.setItem(key, JSON.stringify(old));
    const pending = deferred();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { pending.started(); await pending.wait; return new Response(null, { status: 204 }); });
    const client = auth.createSessionClient(old);
    const events: string[] = [];
    client.auth.onAuthStateChange(event => { events.push(event); });
    const completion = client.auth.signOut({ scope: "local" });
    await pending.entered;
    const newer = { ...old, access_token: "new-token", refresh_token: "new-refresh", user: { ...old.user, id: account === "other" ? "other" : old.user.id } };
    localStorage.setItem(key, JSON.stringify(newer));
    pending.release();
    await expect(completion).rejects.toThrow("Browser session changed during cleanup.");
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(newer);
    expect(events).not.toContain("SIGNED_OUT");
    await client.auth.dispose();
  });

  it("preserves a refreshed session and permits a cleanup retry using it", async () => {
    vi.mocked(auth.createSessionClient).mockRestore();
    const old = origin();
    localStorage.setItem(key, JSON.stringify(old));
    const pending = deferred();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => { pending.started(); await pending.wait; return new Response(null, { status: 204 }); }).mockResolvedValue(new Response(null, { status: 204 }));
    const first = auth.createSessionClient(old);
    const completion = first.auth.signOut({ scope: "local" });
    await pending.entered;
    const refreshed = { ...old, access_token: "refreshed-token", refresh_token: "refreshed-token-2" };
    localStorage.setItem(key, JSON.stringify(refreshed));
    pending.release();
    await expect(completion).rejects.toThrow("Browser session changed during cleanup.");
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(refreshed);
    await first.auth.dispose();
    const retry = auth.createSessionClient(refreshed);
    const result = await retry.auth.signOut({ scope: "local" });
    expect(result.error).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    await retry.auth.dispose();
  });

  it("keeps the newer persisted session when recovery update completes late", async () => {
    vi.mocked(auth.createSessionClient).mockRestore();
    const old = origin();
    localStorage.setItem(key, JSON.stringify(old));
    const pending = deferred();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { pending.started(); await pending.wait; return Response.json(old.user); });
    const recovery = auth.createRecoveryClient(old);
    const events: string[] = [];
    recovery.auth.onAuthStateChange(event => { events.push(event); });
    const update = recovery.auth.updateUser({ password: "new-password" });
    await pending.entered;
    const newer = { ...old, refresh_token: "new-refresh", user: { ...old.user, id: "other" } };
    localStorage.setItem(key, JSON.stringify(newer));
    pending.release();
    await expect(update).rejects.toThrow("Browser session changed during cleanup.");
    expect(events).not.toContain("USER_UPDATED");
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(newer);
    await recovery.auth.dispose();
  });
});
