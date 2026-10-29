import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { Alert, Button } from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { describeError } from "@/api/errors";
import { createPasswordClient, createRecoveryClient, createSessionClient, storedSession, supabase } from "@/supabase";

export type SignUpResult = {
  needsEmailConfirmation: boolean;
};

type AuthContextValue = {
  session: Session | null;
  passwordRecoveryPending: boolean;
  loading: boolean;
  initializationError: Error | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signInWithProvider: (provider: "google" | "github") => Promise<void>;
  sessionGeneration: number;
  isSessionCurrent: (generation: number) => boolean;
  isSessionUsable: (generation: number) => boolean;
  completeSession: (action: string, generation?: number, retrySession?: Session) => Promise<boolean>;
  resetPasswordForEmail: (email: string) => Promise<void>;
  updatePassword: (password: string, origin: Session, generation: number) => Promise<boolean>;
  changePassword: (currentPassword: string, nextPassword: string, originGeneration: number) => Promise<{ sessionToken: string; originGeneration: number } | null>;
  updateDisplayName: (name: string) => Promise<void>;
  updateEmail: (email: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function appOrigin(): string {
  return window.location.origin;
}

function recoveryRedirectTo(): string {
  return `${appOrigin()}/reset-password`;
}

function confirmRedirectTo(): string {
  return `${appOrigin()}/auth/confirm`;
}

type UserAttributes = Parameters<typeof supabase.auth.updateUser>[0];
type UserUpdateOptions = Parameters<typeof supabase.auth.updateUser>[1];

async function updateUserChecked(
  attributes: UserAttributes,
  options: UserUpdateOptions | undefined,
  operation: string
): Promise<User> {
  const { data, error } = await supabase.auth.updateUser(attributes, options);
  if (error) {
    throw error;
  }
  if (!data.user) {
    throw new Error(`${operation} did not return a user.`, { cause: data });
  }
  return data.user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const sessionGeneration = useRef(0);
  const [generation, setGeneration] = useState(0);
  const sessionIdentity = useRef<string | null>(null);
  const currentSession = useRef<Session | null>(null);
  const [cleanupError, setCleanupError] = useState<{ action: string; cause: unknown; generation: number; session: Session } | null>(null);
  const [cleanupPending, setCleanupPending] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [initializationError, setInitializationError] = useState<Error | null>(null);
  const [passwordRecoveryPending, setPasswordRecoveryPending] = useState(false);

  useEffect(() => {
    let mounted = true;
    let authStateChangeReceived = false;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!mounted) return;
      const persisted = storedSession();
      if (event === "SIGNED_OUT" && persisted) return;
      if (nextSession && (!persisted || nextSession.refresh_token !== persisted.refresh_token)) return;
      if (event !== "INITIAL_SESSION") authStateChangeReceived = true;
      const isNewSession = Boolean(
        nextSession && (event === "SIGNED_IN" || event === "PASSWORD_RECOVERY") &&
        nextSession.refresh_token !== sessionIdentity.current
      );
      if (isNewSession) {
        sessionGeneration.current += 1;
        setGeneration(sessionGeneration.current);
        setCleanupError(null);
      }
      if (nextSession) sessionIdentity.current = nextSession.refresh_token;
      currentSession.current = nextSession;
      if (event === "PASSWORD_RECOVERY" && nextSession) {
        setPasswordRecoveryPending(true);
      } else if (event === "SIGNED_OUT" || (event === "SIGNED_IN" && isNewSession)) {
        setPasswordRecoveryPending(false);
      }
      setSession(nextSession);
      if (nextSession) {
        setInitializationError(null);
      }
      setLoading(false);
    });

    void (async () => {
      try {
        const { error: initializationError } = await supabase.auth.initialize();
        if (initializationError) throw initializationError;
        if (authStateChangeReceived) return;

        const { data, error } = await supabase.auth.getSession();
        if (!mounted || authStateChangeReceived) return;
        if (error) {
          setInitializationError(error);
        }
        sessionIdentity.current = data.session?.refresh_token ?? null;
        currentSession.current = data.session;
        setSession(data.session);
        setLoading(false);
      } catch (error: unknown) {
        if (!mounted || authStateChangeReceived) return;
        setInitializationError(
          error instanceof Error ? error : new Error("Session lookup failed", { cause: error })
        );
        setLoading(false);
      }
    })();

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      throw error;
    }
    if (!data.session) {
      throw new Error("Sign-in did not return a session.", { cause: data });
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string): Promise<SignUpResult> => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: confirmRedirectTo(),
      },
    });
    if (error) {
      throw error;
    }
    return { needsEmailConfirmation: !data.session };
  }, []);

  const signInWithProvider = useCallback(async (provider: "google" | "github") => {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: appOrigin() },
    });
    if (error) {
      throw error;
    }
    if (!data.url) {
      throw new Error("Provider sign-in did not return a redirect URL.", { cause: data });
    }
  }, []);

  const isSessionCurrent = useCallback((owner: number) => owner === sessionGeneration.current, []);

  const isSessionUsable = useCallback((owner: number) => {
    if (!isSessionCurrent(owner)) return false;
    const persisted = storedSession();
    return !persisted || persisted.refresh_token === sessionIdentity.current;
  }, [isSessionCurrent]);

  const completeSession = useCallback(async (action: string, generation = sessionGeneration.current, retrySession?: Session) => {
    if (!isSessionCurrent(generation)) return false;
    const origin = currentSession.current ?? retrySession;
    if (!origin) return false;
    const persisted = storedSession();
    if (persisted && persisted.refresh_token !== origin.refresh_token) {
      setCleanupError({ action, cause: new Error("Browser session changed during cleanup; retry after the session update."), generation, session: origin });
      return false;
    }
    setCleanupPending(true);
    const client = createSessionClient(origin);
    let failure: { cause: unknown } | null = null;
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
    } catch (cause) {
      failure = { cause };
    }
    try {
      await client.auth.dispose();
    } catch (cause) {
      failure = { cause: failure ? new AggregateError([failure.cause, cause], "Browser cleanup and client disposal failed.", { cause }) : cause };
    } finally {
      setCleanupPending(false);
    }
    const remaining = storedSession();
    if (!isSessionCurrent(generation)) return false;
    if (remaining && remaining.refresh_token !== origin.refresh_token) {
      setCleanupError({ action, cause: failure?.cause ?? new Error("Browser session changed during cleanup; retry after the session update."), generation, session: origin });
      return false;
    }
    if (!failure && remaining) failure = { cause: new Error("Browser session was not removed.") };
    if (failure) {
      setCleanupError({ action, cause: failure.cause, generation, session: origin });
      return false;
    }
    queryClient.clear();
    currentSession.current = null;
    setSession(null);
    setPasswordRecoveryPending(false);
    setCleanupError(null);
    return true;
  }, [queryClient, isSessionCurrent]);

  const resetPasswordForEmail = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: recoveryRedirectTo(),
    });
    if (error) {
      throw error;
    }
  }, []);

  const updatePassword = useCallback(async (password: string, origin: Session, owner: number) => {
    if (!isSessionUsable(owner)) return false;
    const client = createRecoveryClient(origin);
    let failure: { cause: unknown } | null = null;
    try {
      const { data, error } = await client.auth.updateUser({ password });
      if (error) throw error;
      if (!data.user) throw new Error("Password update did not return a user.", { cause: data });
    } catch (cause) {
      failure = { cause };
    }
    try {
      await client.auth.dispose();
    } catch (cause) {
      if (failure) throw new AggregateError([failure.cause, cause], "Password update and client cleanup failed.", { cause });
      throw cause;
    }
    if (failure) throw failure.cause;
    return true;
  }, [isSessionUsable]);

  const changePassword = useCallback(
    async (currentPassword: string, nextPassword: string, owner: number) => {
      if (!isSessionUsable(owner)) return null;
      const email = session?.user?.email;
      if (!email) throw new Error("Not signed in");
      const client = createPasswordClient();
      let failure: { cause: unknown } | null = null;
      let outcome: { sessionToken: string; originGeneration: number } | null = null;
      try {
        const { data, error } = await client.auth.signInWithPassword({ email, password: currentPassword });
        if (error) throw error;
        if (!data.session) throw new Error("Reauthentication did not return a session", { cause: data });
        if (isSessionUsable(owner)) {
          const result = await client.auth.updateUser({ password: nextPassword });
          if (result.error) throw result.error;
          if (!result.data.user) throw new Error("Password update did not return a user.", { cause: result.data });
          if (isSessionCurrent(owner)) outcome = { sessionToken: data.session.access_token, originGeneration: owner };
        }
      } catch (cause) {
        failure = { cause };
      }
      try {
        await client.auth.dispose();
      } catch (cause) {
        if (failure) throw new AggregateError([failure.cause, cause], "Password change and client cleanup failed.", { cause });
        throw cause;
      }
      if (failure) throw failure.cause;
      return outcome;
    },
    [session?.user?.email, isSessionCurrent, isSessionUsable]
  );

  const updateDisplayName = useCallback(async (name: string) => {
    const trimmed = name.trim();
    const user = await updateUserChecked({ data: { name: trimmed } }, undefined, "Name update");
    if (user.user_metadata?.name !== trimmed) {
      throw new Error("Profile update did not return the saved name.", { cause: user });
    }
  }, []);

  const updateEmail = useCallback(async (email: string) => {
    const trimmed = email.trim();
    if (!trimmed) {
      throw new Error("Email is required");
    }
    await updateUserChecked(
      { email: trimmed },
      { emailRedirectTo: confirmRedirectTo() },
      "Email update"
    );
  }, []);

  const value = useMemo(
    () => ({
      session,
      passwordRecoveryPending,
      loading,
      initializationError,
      signIn,
      signUp,
      signInWithProvider,
      sessionGeneration: generation,
      isSessionCurrent,
      isSessionUsable,
      completeSession,
      resetPasswordForEmail,
      updatePassword,
      changePassword,
      updateDisplayName,
      updateEmail,
    }),
    [
      session,
      passwordRecoveryPending,
      loading,
      initializationError,
      signIn,
      signUp,
      signInWithProvider,
      generation,
      isSessionCurrent,
      isSessionUsable,
      completeSession,
      resetPasswordForEmail,
      updatePassword,
      changePassword,
      updateDisplayName,
      updateEmail,
    ]
  );

  const persistedForNotice = cleanupError ? storedSession() : null;
  const noticeOwned = cleanupError && cleanupError.generation === generation &&
    (!persistedForNotice || persistedForNotice.refresh_token === (session?.refresh_token ?? cleanupError.session.refresh_token));

  return <AuthContext.Provider value={value}>
    {noticeOwned && cleanupError ? <Alert severity="error" onClose={() => setCleanupError(null)} action={<>
      <Button color="inherit" disabled={cleanupPending} onClick={() => void completeSession(cleanupError.action, cleanupError.generation, cleanupError.session)}>Retry browser cleanup</Button>
      <Button color="inherit" onClick={() => setCleanupError(null)}>Dismiss</Button>
    </>}>
      {cleanupError.action} completed, but browser cleanup failed: {describeError(cleanupError.cause)}
    </Alert> : null}
    {children}
  </AuthContext.Provider>;
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
