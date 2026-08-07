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
import type { UsageResponse } from "@/api/types";
import { fetchModels } from "@/api/models";
import { AppChrome } from "@/components/AppChrome";
import { Section } from "@/components/Section";
import { brand } from "@/theme";

/** Survives Dodo checkout round-trips until /account/usage exposes access_until. */
const CANCEL_ACCESS_UNTIL_KEY = "devneya.cancelAccessUntil";

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

function formatAccessUntil(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function readStoredAccessUntil(): string | undefined {
  try {
    const raw = sessionStorage.getItem(CANCEL_ACCESS_UNTIL_KEY);
    if (!raw) {
      return undefined;
    }
    const at = Date.parse(raw);
    if (Number.isNaN(at) || at <= Date.now()) {
      sessionStorage.removeItem(CANCEL_ACCESS_UNTIL_KEY);
      return undefined;
    }
    return raw;
  } catch {
    return undefined;
  }
}

function storeAccessUntil(iso: string | undefined): void {
  try {
    if (!iso) {
      sessionStorage.removeItem(CANCEL_ACCESS_UNTIL_KEY);
      return;
    }
    sessionStorage.setItem(CANCEL_ACCESS_UNTIL_KEY, iso);
  } catch {
    // ignore quota / private mode
  }
}

function mergeUsageAccessUntil(usage: UsageResponse): UsageResponse {
  if (usage.access_until) {
    storeAccessUntil(usage.access_until);
    return usage;
  }
  if (usage.subscription_status !== "active") {
    storeAccessUntil(undefined);
    return usage;
  }
  const stored = readStoredAccessUntil();
  return stored ? { ...usage, access_until: stored } : usage;
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
    queryFn: async () => mergeUsageAccessUntil(await fetchUsage(token)),
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
      storeAccessUntil(undefined);
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelSubscription(token),
    onSuccess: (data) => {
      // Cancel response status "cancelled" means the cancel was accepted.
      // With access_until, paid access continues — usage stays "active" until then.
      if (data.access_until) {
        storeAccessUntil(data.access_until);
        queryClient.setQueryData<UsageResponse>(["usage", token], (current) =>
          current
            ? {
                ...current,
                subscription_status: "active",
                access_until: data.access_until,
              }
            : current
        );
        return;
      }
      storeAccessUntil(undefined);
      queryClient.setQueryData<UsageResponse>(["usage", token], (current) =>
        current
          ? {
              ...current,
              subscription_status: "cancelled",
              access_until: undefined,
            }
          : current
      );
    },
  });

  const usage = usageQuery.data;
  const usagePercent =
    usage && usage.limit > 0 ? Math.min(100, (usage.used / usage.limit) * 100) : 0;
  const models = modelsQuery.data?.data ?? [];
  const status = usage?.subscription_status;
  const accessUntil = usage?.access_until;
  const cancelScheduled = status === "active" && Boolean(accessUntil);

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
                  Status: <strong>{status}</strong>
                </Typography>
                {cancelScheduled ? (
                  <Typography variant="body2" color="text.secondary">
                    Cancellation scheduled. Access until {formatAccessUntil(accessUntil!)}.
                  </Typography>
                ) : null}
                <Box>
                  <Typography sx={{ mb: 1 }}>
                    Spent: {formatUsd(usage.used)} / {formatUsd(usage.limit)}
                  </Typography>
                  <Box
                    role="progressbar"
                    aria-label="Usage progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(usagePercent)}
                    aria-valuetext={`${formatUsd(usage.used)} of ${formatUsd(usage.limit)}`}
                    sx={{
                      height: 8,
                      bgcolor: brand.soft,
                      border: `1px solid ${brand.hairline}`,
                      overflow: "hidden",
                    }}
                  >
                    <Box
                      sx={{
                        height: "100%",
                        width: `${usagePercent}%`,
                        // Keep a visible marker once any spend exists (true % can be << 1%).
                        minWidth: usage.used > 0 ? 4 : 0,
                        maxWidth: "100%",
                        bgcolor: brand.yellow,
                        transition: "width 200ms ease-out",
                      }}
                    />
                  </Box>
                </Box>
                <Stack direction="row" spacing={2}>
                  {status === "none" || status === "cancelled" ? (
                    <Button
                      variant="contained"
                      onClick={() => subscribeMutation.mutate()}
                      disabled={subscribeMutation.isPending}
                    >
                      Subscribe
                    </Button>
                  ) : null}
                  {cancelScheduled ? (
                    <Button
                      variant="contained"
                      onClick={() => subscribeMutation.mutate()}
                      disabled={subscribeMutation.isPending}
                    >
                      Resubscribe
                    </Button>
                  ) : null}
                  {status === "active" && !cancelScheduled ? (
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
