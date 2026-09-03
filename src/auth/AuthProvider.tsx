import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/supabase";

export type SignUpResult = {
  needsEmailConfirmation: boolean;
};

type AuthContextValue = {
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<SignUpResult>;
  signInWithProvider: (provider: "google" | "github") => Promise<void>;
  signOut: () => Promise<void>;
  resetPasswordForEmail: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  changePassword: (currentPassword: string, nextPassword: string) => Promise<string>;
  updateDisplayName: (name: string) => Promise<void>;
  updateEmail: (email: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function appOrigin(): string {
  if (typeof window === "undefined") {
    return "https://app.devneya.com";
  }
  return window.location.origin;
}

function recoveryRedirectTo(): string {
  return `${appOrigin()}/reset-password`;
}

function confirmRedirectTo(): string {
  return `${appOrigin()}/auth/confirm`;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      throw error;
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
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: appOrigin() },
    });
    if (error) {
      throw error;
    }
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) {
      throw error;
    }
  }, []);

  const resetPasswordForEmail = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: recoveryRedirectTo(),
    });
    if (error) {
      throw error;
    }
  }, []);

  const updatePassword = useCallback(async (password: string) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      throw error;
    }
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, nextPassword: string) => {
      const email = session?.user?.email;
      if (!email) {
        throw new Error("Not signed in");
      }
      const { data, error: reauthError } = await supabase.auth.signInWithPassword({
        email,
        password: currentPassword,
      });
      if (reauthError) {
        throw reauthError;
      }
      if (!data.session) {
        throw new Error("Reauthentication did not return a session");
      }
      const { error } = await supabase.auth.updateUser({ password: nextPassword });
      if (error) {
        throw error;
      }
      return data.session.access_token;
    },
    [session?.user?.email]
  );

  const updateDisplayName = useCallback(async (name: string) => {
    const trimmed = name.trim();
    const { error } = await supabase.auth.updateUser({
      data: { name: trimmed },
    });
    if (error) {
      throw error;
    }
  }, []);

  const updateEmail = useCallback(async (email: string) => {
    const trimmed = email.trim();
    if (!trimmed) {
      throw new Error("Email is required");
    }
    const { error } = await supabase.auth.updateUser(
      { email: trimmed },
      { emailRedirectTo: confirmRedirectTo() }
    );
    if (error) {
      throw error;
    }
  }, []);

  const value = useMemo(
    () => ({
      session,
      loading,
      signIn,
      signUp,
      signInWithProvider,
      signOut,
      resetPasswordForEmail,
      updatePassword,
      changePassword,
      updateDisplayName,
      updateEmail,
    }),
    [
      session,
      loading,
      signIn,
      signUp,
      signInWithProvider,
      signOut,
      resetPasswordForEmail,
      updatePassword,
      changePassword,
      updateDisplayName,
      updateEmail,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
