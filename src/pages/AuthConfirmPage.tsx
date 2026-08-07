import { useEffect, useMemo, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { Alert, Button, Stack, Typography } from "@mui/material";
import { useAuth } from "@/auth/useAuth";
import { AuthShell } from "@/components/AuthShell";

function hashParams(): URLSearchParams {
  if (typeof window === "undefined") {
    return new URLSearchParams();
  }
  const raw = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(raw);
}

export function AuthConfirmPage() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const [timedOut, setTimedOut] = useState(false);

  const linkError = useMemo(() => {
    const params = hashParams();
    const error = params.get("error");
    const description = params.get("error_description");
    if (!error && !description) {
      return null;
    }
    return description?.replace(/\+/g, " ") || error || "Confirmation failed";
  }, []);

  useEffect(() => {
    if (loading || linkError) {
      return;
    }
    if (session) {
      navigate("/", { replace: true });
    }
  }, [loading, linkError, session, navigate]);

  useEffect(() => {
    if (loading || linkError || session) {
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(true), 4000);
    return () => window.clearTimeout(timer);
  }, [loading, linkError, session]);

  if (linkError) {
    return (
      <AuthShell title="Confirmation failed" subtitle="The link may be invalid or expired.">
        <Stack spacing={2}>
          <Alert severity="error">{linkError}</Alert>
          <Button component={RouterLink} to="/login" variant="contained">
            Back to sign in
          </Button>
        </Stack>
      </AuthShell>
    );
  }

  if (timedOut && !session) {
    return (
      <AuthShell
        title="Almost there"
        subtitle="If you confirmed a signup, sign in with your email and password. Email changes finish after both confirmation links are opened."
      >
        <Stack spacing={2}>
          <Alert severity="info">
            No session was created from this link. That is normal for the second email-change
            confirmation — open the other link if you have not already, then sign in.
          </Alert>
          <Button component={RouterLink} to="/login" variant="contained">
            Back to sign in
          </Button>
        </Stack>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Confirming…" subtitle="Finishing email confirmation.">
      <Typography variant="body2" color="text.secondary">
        One moment while we verify your link.
      </Typography>
    </AuthShell>
  );
}
