import { useEffect, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Alert, Box, Button, Link, Stack, TextField, Typography } from "@mui/material";
import { useAuth } from "@/auth/useAuth";
import { AuthShell } from "@/components/AuthShell";
import { supabase } from "@/supabase";

export function ResetPasswordPage() {
  const { session, updatePassword } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let active = true;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") {
        if (active) {
          setReady(true);
        }
      }
    });

    void supabase.auth.getSession().then(({ data }) => {
      if (active && data.session) {
        setReady(true);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await updatePassword(password);
      setDone(true);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update password");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return null;
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="Use at least 6 characters. You’ll stay signed in after saving."
    >
      {!ready && !session ? (
        <Stack spacing={2}>
          <Alert severity="info">
            Open the reset link from your email to continue. If the link expired, request a
            new one.
          </Alert>
          <Typography variant="body2">
            <Link component={RouterLink} to="/forgot-password" underline="hover">
              Request a new reset link
            </Link>
          </Typography>
        </Stack>
      ) : (
        <Box component="form" onSubmit={handleSubmit} noValidate>
          <Stack spacing={2}>
            {error ? <Alert severity="error">{error}</Alert> : null}
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              fullWidth
              slotProps={{ htmlInput: { minLength: 6 } }}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <TextField
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              required
              fullWidth
              slotProps={{ htmlInput: { minLength: 6 } }}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            <Button type="submit" variant="contained" size="large" disabled={submitting}>
              Save password
            </Button>
          </Stack>
        </Box>
      )}
    </AuthShell>
  );
}
