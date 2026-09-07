import { useEffect, useRef, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Box, Button, Link, Stack, TextField, Typography } from "@mui/material";
import { useAuth } from "@/auth/useAuth";
import { logout } from "@/api/account";
import { describeError } from "@/api/errors";
import { AuthShell } from "@/components/AuthShell";
import { supabase } from "@/supabase";

type PasswordStage = "none" | "password_changed" | "backend_logged_out";

export function ResetPasswordPage() {
  const { session, updatePassword, signOut } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [passwordStage, setPasswordStage] = useState<PasswordStage>("none");
  const passwordLogoutTokenRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        if (active) {
          setReady(true);
        }
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
    setSubmitting(true);
    let stage = passwordStage;
    try {
      if (stage === "none") {
        if (password.length < 6) {
          throw new Error("Password must be at least 6 characters.");
        }
        if (password !== confirm) {
          throw new Error("Passwords do not match.");
        }
        const token = session?.access_token;
        if (!token) {
          throw new Error("Recovery session is missing.");
        }
        await updatePassword(password);
        passwordLogoutTokenRef.current = token;
        stage = "password_changed";
        setPasswordStage(stage);
      }

      if (stage === "password_changed") {
        const token = passwordLogoutTokenRef.current;
        if (!token) {
          throw new Error("Password change recovery state is missing.");
        }
        await logout(token);
        stage = "backend_logged_out";
        setPasswordStage(stage);
      }

      if (stage === "backend_logged_out") {
        await signOut();
        queryClient.clear();
        sessionStorage.setItem("devneya.passwordChanged", "1");
        setDone(true);
        navigate("/login", { replace: true });
      }
    } catch (err) {
      setError(
        stage === "backend_logged_out"
          ? `Password changed and backend logout completed, but local sign-out failed: ${describeError(err)}`
          : stage === "password_changed"
            ? `Password changed, but backend logout failed: ${describeError(err)}`
            : describeError(err, "Could not update password")
      );
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
      subtitle="Use at least 6 characters. Sign in again after saving."
    >
      {!ready ? (
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
            {passwordStage === "none" ? (
              <>
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
              </>
            ) : null}
            <Button type="submit" variant="contained" size="large" disabled={submitting}>
              {passwordStage === "none"
                ? "Save password"
                : passwordStage === "password_changed"
                  ? "Finish password change"
                  : "Finish local sign-out"}
            </Button>
          </Stack>
        </Box>
      )}
    </AuthShell>
  );
}
