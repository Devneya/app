import { useState } from "react";
import { Link as RouterLink } from "react-router-dom";
import { Alert, Box, Button, Link, Stack, TextField, Typography } from "@mui/material";
import { useAuth } from "@/auth/useAuth";
import { AuthShell } from "@/components/AuthShell";

export function ForgotPasswordPage() {
  const { resetPasswordForEmail } = useAuth();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await resetPasswordForEmail(email);
      setSent(true);
    } catch (err) {
      // Avoid email enumeration: still show success for typical "user not found"
      // responses from GoTrue, but surface unexpected failures.
      const message = err instanceof Error ? err.message : "Request failed";
      if (/rate limit|network|fetch/i.test(message)) {
        setError(message);
      } else {
        setSent(true);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Forgot password"
      subtitle="Enter your email and we’ll send a reset link if an account exists."
    >
      {sent ? (
        <Stack spacing={2}>
          <Alert severity="success">
            If an account exists for that email, a reset link is on its way. Check your inbox
            (and spam folder).
          </Alert>
          <Button component={RouterLink} to="/login" variant="contained">
            Back to sign in
          </Button>
        </Stack>
      ) : (
        <Box component="form" onSubmit={handleSubmit} noValidate>
          <Stack spacing={2}>
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
            <Button type="submit" variant="contained" size="large" disabled={submitting}>
              Send reset link
            </Button>
            <Typography variant="body2">
              <Link component={RouterLink} to="/login" underline="hover">
                Back to sign in
              </Link>
            </Typography>
          </Stack>
        </Box>
      )}
    </AuthShell>
  );
}
