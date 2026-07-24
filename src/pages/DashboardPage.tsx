import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  AppBar,
  Button,
  Container,
  LinearProgress,
  Paper,
  Stack,
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

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function DashboardPage() {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = session?.access_token ?? "";

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
      <AppBar position="static" color="default" elevation={1}>
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Devneya Account
          </Typography>
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

          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              API key
            </Typography>
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
                    bgcolor: "grey.100",
                    p: 1.5,
                    borderRadius: 1,
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
          </Paper>

          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom>
              Usage & subscription
            </Typography>
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
          </Paper>

          <Paper sx={{ p: 3 }}>
            <Typography variant="h6" gutterBottom color="error">
              Danger zone
            </Typography>
            <Button
              variant="outlined"
              color="error"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              Delete account
            </Button>
          </Paper>
        </Stack>
      </Container>
    </>
  );
}
