import { useState } from "react";
import { Navigate, Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, Link, Stack, TextField, Typography } from "@mui/material";
import { useAuth } from "@/auth/useAuth";
import { AuthShell } from "@/components/AuthShell";

const PASSWORD_CHANGED_KEY = "devneya.passwordChanged";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (session) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "signin") {
        await signIn(email, password);
      } else {
        await signUp(email, password);
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
          onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        >
          {mode === "signin" ? "Sign up" : "Sign in"}
        </Link>
      </Typography>
    </AuthShell>
  );
}
