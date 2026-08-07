import { useState } from "react";
import { Navigate, Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, Link, Stack, TextField, Typography } from "@mui/material";
import { useAuth } from "@/auth/useAuth";
import { AuthShell } from "@/components/AuthShell";
import { config } from "@/config";

const PASSWORD_CHANGED_KEY = "devneya.passwordChanged";

const DEMO_EMAIL = "demo@devneya.com";
const DEMO_PASSWORD = "password123";

function isLocalHost(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
}

function defaultDemoCredentials(): { email: string; password: string } {
  // Vitest/jsdom reports hostname "localhost"; never prefill in tests.
  if (import.meta.env.MODE === "test") {
    return { email: "", password: "" };
  }
  if (isLocalHost() && config.useMocks) {
    return { email: DEMO_EMAIL, password: DEMO_PASSWORD };
  }
  return { email: "", password: "" };
}

export function LoginPage() {
  const { session, signIn, signUp } = useAuth();
  const [passwordChanged] = useState(() => {
    if (typeof sessionStorage === "undefined") {
      return false;
    }
    if (sessionStorage.getItem(PASSWORD_CHANGED_KEY) === "1") {
      sessionStorage.removeItem(PASSWORD_CHANGED_KEY);
      return true;
    }
    return false;
  });
  const demoDefaults = defaultDemoCredentials();
  const [email, setEmail] = useState(demoDefaults.email);
  const [password, setPassword] = useState(demoDefaults.password);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [checkEmail, setCheckEmail] = useState<string | null>(null);

  if (session) {
    return <Navigate to="/" replace />;
  }

  if (checkEmail) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="Confirm your address to finish creating your account."
      >
        <Stack spacing={2}>
          <Alert severity="success">
            We sent a confirmation link to <strong>{checkEmail}</strong>. Open it to activate
            your account, then sign in.
          </Alert>
          <Button
            variant="contained"
            onClick={() => {
              setCheckEmail(null);
              setMode("signin");
              setPassword("");
            }}
          >
            Back to sign in
          </Button>
        </Stack>
      </AuthShell>
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "signin") {
        await signIn(email, password);
      } else {
        const result = await signUp(email, password);
        if (result.needsEmailConfirmation) {
          setCheckEmail(email.trim());
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title={mode === "signin" ? "Sign in" : "Create account"}
      subtitle="Manage your API key and subscription."
    >
      <Box component="form" onSubmit={handleSubmit} noValidate>
        <Stack spacing={2}>
          {passwordChanged ? (
            <Alert severity="success">Password updated. Sign in with your new password.</Alert>
          ) : null}
          {error ? <Alert severity="error">{error}</Alert> : null}
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            fullWidth
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            fullWidth
            slotProps={{ htmlInput: { minLength: 6 } }}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {mode === "signin" ? (
            <Typography variant="body2" sx={{ textAlign: "right", mt: -1 }}>
              <Link component={RouterLink} to="/forgot-password" underline="hover">
                Forgot password?
              </Link>
            </Typography>
          ) : null}
          <Button type="submit" variant="contained" size="large" disabled={submitting}>
            {mode === "signin" ? "Sign in" : "Create account"}
          </Button>
        </Stack>
      </Box>

      <Typography sx={{ mt: 3 }}>
        {mode === "signin" ? "Need an account?" : "Already have an account?"}{" "}
        <Link
          component="button"
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
          }}
        >
          {mode === "signin" ? "Sign up" : "Sign in"}
        </Link>
      </Typography>
    </AuthShell>
  );
}
