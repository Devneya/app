import { useRef, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Alert, Box, Button, Link, Stack, TextField, Typography } from "@mui/material";
import { useAuth } from "@/auth/useAuth";
import { logout } from "@/api/account";
import { describeError } from "@/api/errors";
import { AuthShell } from "@/components/AuthShell";

type PasswordStage = "none" | "password_changed" | "backend_logged_out";
type ResetError = { cause: unknown; stage: PasswordStage; owner: number };

export function ResetPasswordPage() {
  const { session, sessionGeneration, isSessionCurrent, isSessionUsable, passwordRecoveryPending, updatePassword, completeSession } = useAuth();
  const navigate = useNavigate();
  const [passwordFields, setPasswordFields] = useState({ owner: sessionGeneration, password: "", confirm: "" });
  const fields = passwordFields.owner === sessionGeneration && isSessionUsable(sessionGeneration) ? passwordFields : { owner: sessionGeneration, password: "", confirm: "" };
  const { password, confirm } = fields;
  const [submitting, setSubmitting] = useState(false);
  const [savedError, setError] = useState<ResetError | null>(null);
  const error = savedError?.owner === sessionGeneration && isSessionUsable(sessionGeneration) ? savedError : null;
  const [doneOwner, setDoneOwner] = useState<number | null>(null);
  const [passwordProgress, setPasswordProgress] = useState<{ owner: number; stage: PasswordStage } | null>(null);
  const passwordStage = passwordProgress?.owner === sessionGeneration && isSessionUsable(sessionGeneration) ? passwordProgress.stage : "none";
  const passwordLogoutTokenRef = useRef<{ owner: number; token: string } | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const owner = sessionGeneration;
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
        if (!session) throw new Error("Recovery session is missing.");
        if (!await updatePassword(password, session, owner)) return;
        if (!isSessionCurrent(owner)) return;
        passwordLogoutTokenRef.current = { owner, token };
        stage = "password_changed";
        setPasswordProgress({ owner, stage });
      }

      if (stage === "password_changed") {
        const token = passwordLogoutTokenRef.current;
        if (!token || token.owner !== owner) {
          throw new Error("Password change recovery state is missing.");
        }
        if (!isSessionUsable(owner)) return;
        await logout(token.token);
        if (!isSessionCurrent(owner)) return;
        stage = "backend_logged_out";
        setPasswordProgress({ owner, stage });
      }

      if (stage === "backend_logged_out") {
        const completed = await completeSession("Password recovery", owner);
        if (!isSessionCurrent(owner)) return;
        sessionStorage.setItem("devneya.passwordChanged", "1");
        if (completed) {
          setDoneOwner(owner);
          navigate("/login", { replace: true });
        }
      }
    } catch (err) {
      if (isSessionCurrent(owner)) setError({ cause: err, stage, owner });
    } finally {
      setSubmitting(false);
    }
  }

  if (doneOwner === sessionGeneration && isSessionUsable(sessionGeneration)) {
    return null;
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="Use at least 6 characters. Sign in again after saving."
    >
      {!passwordRecoveryPending ? (
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
            {error ? (
              <Alert severity="error">
                {error.stage === "backend_logged_out"
                  ? `Password changed and backend logout completed, but local sign-out failed: ${describeError(error.cause)}`
                  : error.stage === "password_changed"
                    ? `Password changed, but backend logout failed: ${describeError(error.cause)}`
                    : describeError(error.cause, "Could not update password")}
              </Alert>
            ) : null}
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
                  onChange={(e) => setPasswordFields({ ...fields, password: e.target.value })}
                />
                <TextField
                  label="Confirm new password"
                  type="password"
                  autoComplete="new-password"
                  required
                  fullWidth
                  slotProps={{ htmlInput: { minLength: 6 } }}
                  value={confirm}
                  onChange={(e) => setPasswordFields({ ...fields, confirm: e.target.value })}
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
