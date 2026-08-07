import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  AppBar,
  Box,
  Button,
  Container,
  LinearProgress,
  Stack,
  TextField,
  Toolbar,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { useAuth } from "@/auth/useAuth";
import {
  cancelSubscription,
  deleteAccount,
  fetchUsage,
  fetchVirtualKey,
  logout,
  startSubscription,
} from "@/api/account";
import { brand } from "@/theme";

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function Section({
  title,
  children,
  danger,
}: {
  title: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: danger ? "error.light" : "divider",
        borderRadius: 2,
        p: 3,
      }}
    >
      <Typography
        variant="h6"
        gutterBottom
        color={danger ? "error" : "text.primary"}
        sx={{ fontWeight: 600 }}
      >
        {title}
      </Typography>
      {children}
    </Box>
  );
}

export function DashboardPage() {
  const { session, signOut, changePassword } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = session?.access_token ?? "";

  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);

  const keyQuery = useQuery({
    queryKey: ["virtualKey", token],
    queryFn: () => fetchVirtualKey(token),
    enabled: Boolean(token),
  });

  const usageQuery = useQuery({
    queryKey: ["usage", token],
    queryFn: () => fetchUsage(token),
    enabled: Boolean(token),
  });

  const subscribeMutation = useMutation({
    mutationFn: () => startSubscription(token),
    onSuccess: (data) => {
      if (data.status === "checkout" && "checkout_url" in data) {
        window.location.href = data.checkout_url;
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelSubscription(token),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
    },
  });

  const logoutMutation = useMutation({
    mutationFn: async () => {
      await logout(token);
      await signOut();
    },
    onSuccess: () => navigate("/login"),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await deleteAccount(token);
      await signOut();
    },
    onSuccess: () => navigate("/login"),
  });

  const passwordMutation = useMutation({
    mutationFn: async () => {
      if (nextPassword.length < 6) {
        throw new Error("Password must be at least 6 characters.");
      }
      if (nextPassword !== confirmPassword) {
        throw new Error("Passwords do not match.");
      }
      await changePassword(currentPassword, nextPassword);
      // Revoke API/server sessions, then clear local GoTrue session.
      try {
        await logout(token);
      } catch {
        // Still sign out locally even if revoke fails.
      }
      sessionStorage.setItem("devneya.passwordChanged", "1");
      await signOut();
    },
    onSuccess: () => {
      navigate("/login", { replace: true });
    },
  });

  const usage = usageQuery.data;
  const usagePercent =
    usage && usage.limit > 0 ? Math.min(100, (usage.used / usage.limit) * 100) : 0;

  async function copyKey() {
    if (!keyQuery.data?.key) {
      return;
    }
    await navigator.clipboard.writeText(keyQuery.data.key);
  }

  const actionError =
    subscribeMutation.error ??
    cancelMutation.error ??
    logoutMutation.error ??
    deleteMutation.error;

  return (
    <>
      <AppBar
        position="static"
        color="transparent"
        elevation={0}
        sx={{ borderBottom: "1px solid", borderColor: "divider", bgcolor: "background.paper" }}
      >
        <Toolbar sx={{ gap: 2 }}>
          <Typography
            variant="h6"
            component="div"
            sx={{
              flexGrow: 1,
              fontFamily: '"Monomaniac One", "Roboto Condensed", sans-serif',
              fontWeight: 400,
            }}
          >
            Devneya
            <Box
              component="span"
              sx={{
                ml: 1.5,
                px: 1,
                py: 0.25,
                bgcolor: brand.yellow,
                color: brand.black,
                borderRadius: 1,
                fontFamily: '"Roboto Condensed", sans-serif',
                fontSize: 12,
                fontWeight: 600,
                verticalAlign: "middle",
              }}
            >
              Account
            </Box>
          </Typography>
          {session?.user?.email ? (
            <Typography variant="body2" color="text.secondary" sx={{ display: { xs: "none", sm: "block" } }}>
              {session.user.email}
            </Typography>
          ) : null}
          <Button
            color="inherit"
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
          >
            Log out
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ mt: 4, mb: 6 }}>
        <Stack spacing={3}>
          {actionError ? (
            <Alert severity="error">
              {actionError instanceof Error ? actionError.message : "Request failed"}
            </Alert>
          ) : null}

          <Section title="API key">
            {keyQuery.isLoading ? (
              <LinearProgress aria-label="Loading API key" />
            ) : keyQuery.error ? (
              <Alert severity="error">Could not load API key</Alert>
            ) : (
              <Stack
                direction={{ xs: "column", sm: "row" }}
                spacing={2}
                sx={{ alignItems: "center" }}
              >
                <Typography
                  component="code"
                  sx={{
                    wordBreak: "break-all",
                    flex: 1,
                    bgcolor: brand.canvas,
                    p: 1.5,
                    borderRadius: 1,
                    border: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  {keyQuery.data?.key}
                </Typography>
                <Button
                  variant="outlined"
                  startIcon={<ContentCopyIcon />}
                  onClick={() => void copyKey()}
                >
                  Copy
                </Button>
              </Stack>
            )}
          </Section>

          <Section title="Usage & subscription">
            {usageQuery.isLoading ? (
              <LinearProgress aria-label="Loading usage" />
            ) : usageQuery.error || !usage ? (
              <Alert severity="error">Could not load usage</Alert>
            ) : (
              <Stack spacing={2}>
                <Typography>
                  Status: <strong>{usage.subscription_status}</strong>
                </Typography>
                <Typography>
                  Spent {formatUsd(usage.used)} of {formatUsd(usage.limit)} this period
                </Typography>
                <LinearProgress
                  variant="determinate"
                  value={usagePercent}
                  aria-label="Usage progress"
                  sx={{
                    height: 8,
                    borderRadius: 1,
                    bgcolor: "grey.200",
                    "& .MuiLinearProgress-bar": { bgcolor: brand.yellow },
                  }}
                />
                <Stack direction="row" spacing={2}>
                  {usage.subscription_status === "none" ? (
                    <Button
                      variant="contained"
                      onClick={() => subscribeMutation.mutate()}
                      disabled={subscribeMutation.isPending}
                    >
                      Subscribe
                    </Button>
                  ) : null}
                  {usage.subscription_status === "active" ? (
                    <Button
                      variant="outlined"
                      color="warning"
                      onClick={() => cancelMutation.mutate()}
                      disabled={cancelMutation.isPending}
                    >
                      Cancel subscription
                    </Button>
                  ) : null}
                </Stack>
              </Stack>
            )}
          </Section>

          <Section title="Account security">
            <Stack
              component="form"
              spacing={2}
              onSubmit={(event) => {
                event.preventDefault();
                setPasswordMessage(null);
                passwordMutation.mutate();
              }}
            >
              {passwordMutation.error ? (
                <Alert severity="error">
                  {passwordMutation.error instanceof Error
                    ? passwordMutation.error.message
                    : "Could not change password"}
                </Alert>
              ) : null}
              {passwordMessage ? <Alert severity="success">{passwordMessage}</Alert> : null}
              <TextField
                label="Current password"
                type="password"
                autoComplete="current-password"
                required
                fullWidth
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
              <TextField
                label="New password"
                type="password"
                autoComplete="new-password"
                required
                fullWidth
                slotProps={{ htmlInput: { minLength: 6 } }}
                value={nextPassword}
                onChange={(e) => setNextPassword(e.target.value)}
              />
              <TextField
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                required
                fullWidth
                slotProps={{ htmlInput: { minLength: 6 } }}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
              <Button
                type="submit"
                variant="contained"
                disabled={passwordMutation.isPending}
                sx={{ alignSelf: "flex-start" }}
              >
                Change password
              </Button>
              <Typography variant="body2" color="text.secondary">
                Changing your password signs you out of other sessions.
              </Typography>
            </Stack>
          </Section>

          <Section title="Danger zone" danger>
            <Button
              variant="outlined"
              color="error"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              Delete account
            </Button>
          </Section>
        </Stack>
      </Container>
    </>
  );
}
