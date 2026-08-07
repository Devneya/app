import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Box,
  Button,
  Container,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { useAuth } from "@/auth/useAuth";
import { cancelSubscription, fetchUsage, fetchVirtualKey, startSubscription } from "@/api/account";
import { fetchModels } from "@/api/models";
import { AppChrome } from "@/components/AppChrome";
import { Section } from "@/components/Section";
import { brand } from "@/theme";

/** Format USD for usage UI. Tiny spends must not round to "$0.00". */
function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) {
    return "$0.00";
  }
  const abs = Math.abs(value);
  if (abs < 0.01) {
    const digits = Math.min(6, Math.max(4, Math.ceil(-Math.log10(abs)) + 1));
    return `$${value.toFixed(digits)}`;
  }
  return `$${value.toFixed(2)}`;
}

export function InferencePage() {
  const { session } = useAuth();
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

  const modelsQuery = useQuery({
    queryKey: ["models"],
    queryFn: fetchModels,
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

  const usage = usageQuery.data;
  const usagePercent =
    usage && usage.limit > 0 ? Math.min(100, (usage.used / usage.limit) * 100) : 0;
  const models = modelsQuery.data?.data ?? [];

  async function copyKey() {
    if (!keyQuery.data?.key) {
      return;
    }
    await navigator.clipboard.writeText(keyQuery.data.key);
  }

  const actionError = subscribeMutation.error ?? cancelMutation.error;

  return (
    <>
      <AppChrome section="inference" />

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
                    bgcolor: brand.soft,
                    p: 1.5,
                    borderRadius: 0,
                    border: `1px solid ${brand.hairline}`,
                    fontSize: "0.8125rem",
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

          <Section title="Available models">
            {modelsQuery.isLoading ? (
              <LinearProgress aria-label="Loading models" />
            ) : modelsQuery.error ? (
              <Alert severity="error">Could not load models</Alert>
            ) : models.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No models available right now.
              </Typography>
            ) : (
              <Box
                component="ul"
                aria-label="Available models"
                sx={{
                  m: 0,
                  pl: 0,
                  listStyle: "none",
                  borderTop: `1px solid ${brand.hairline}`,
                }}
              >
                {models.map((model) => (
                  <Box
                    component="li"
                    key={model.id}
                    sx={{
                      py: 1.25,
                      borderBottom: `1px solid ${brand.hairline}`,
                      fontFamily: "inherit",
                      fontSize: "0.875rem",
                    }}
                  >
                    <Typography component="code" sx={{ fontSize: "0.875rem" }}>
                      {model.id}
                    </Typography>
                  </Box>
                ))}
              </Box>
            )}
          </Section>
        </Stack>
      </Container>
    </>
  );
}
