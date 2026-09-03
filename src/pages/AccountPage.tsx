import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Alert, Box, Button, Container, Stack, TextField, Typography } from "@mui/material";
import { useAuth } from "@/auth/useAuth";
import { deleteAccount, logout } from "@/api/account";
import { AppChrome } from "@/components/AppChrome";
import { Section } from "@/components/Section";
import { brand } from "@/theme";

function readSavedName(session: ReturnType<typeof useAuth>["session"]): string {
  const name = session?.user?.user_metadata?.name;
  return typeof name === "string" ? name : "";
}

export function AccountPage() {
  const { session, signOut, changePassword, updateDisplayName, updateEmail } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const token = session?.access_token ?? "";
  const accountEmail = session?.user?.email ?? "";
  const savedName = readSavedName(session);

  const [displayName, setDisplayName] = useState(() => readSavedName(session));
  const [email, setEmail] = useState(() => accountEmail);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileMessageSeverity, setProfileMessageSeverity] = useState<"success" | "info">(
    "success"
  );
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const profileMutation = useMutation({
    mutationFn: async () => {
      const nextName = displayName.trim();
      const nextEmail = email.trim();
      if (!nextEmail) {
        throw new Error("Email is required");
      }
      const nameChanged = nextName !== savedName.trim();
      const emailChanged = nextEmail.toLowerCase() !== accountEmail.toLowerCase();
      if (!nameChanged && !emailChanged) {
        return { nameChanged: false, emailChanged: false, nextEmail };
      }
      if (nameChanged) {
        await updateDisplayName(nextName);
      }
      if (emailChanged) {
        await updateEmail(nextEmail);
      }
      return { nameChanged, emailChanged, nextEmail };
    },
    onSuccess: (result) => {
      if (!result) {
        return;
      }
      setDisplayName(displayName.trim());
      if (result.emailChanged) {
        setPendingEmail(result.nextEmail);
        setEmail(accountEmail);
        setProfileMessageSeverity("info");
        setProfileMessage(
          result.nameChanged
            ? "Name saved. We sent confirmations to both your old and new email — click both to finish changing your email."
            : "We sent confirmations to both your old and new email — click both to finish."
        );
        return;
      }
      setProfileMessageSeverity("success");
      setProfileMessage("Profile saved.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await deleteAccount(token);
      await signOut();
      queryClient.clear();
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
      const currentToken = await changePassword(currentPassword, nextPassword);
      await logout(currentToken);
      sessionStorage.setItem("devneya.passwordChanged", "1");
      await signOut();
      queryClient.clear();
    },
    onSuccess: () => {
      navigate("/login", { replace: true });
    },
  });

  const nameDirty = displayName.trim() !== savedName.trim();
  const emailDirty = email.trim().toLowerCase() !== accountEmail.toLowerCase();
  const profileDirty = nameDirty || emailDirty;

  return (
    <>
      <AppChrome section="account" />

      <Container maxWidth="md" sx={{ mt: 4, mb: 6 }}>
        <Stack spacing={3}>
          {deleteMutation.error ? (
            <Alert severity="error">
              {deleteMutation.error instanceof Error
                ? deleteMutation.error.message
                : "Request failed"}
            </Alert>
          ) : null}

          <Section title="Profile">
            <Stack
              component="form"
              spacing={2}
              onSubmit={(event) => {
                event.preventDefault();
                setProfileMessage(null);
                profileMutation.mutate();
              }}
            >
              {profileMutation.error ? (
                <Alert severity="error">
                  {profileMutation.error instanceof Error
                    ? profileMutation.error.message
                    : "Could not save profile"}
                </Alert>
              ) : null}
              {profileMessage ? (
                <Alert severity={profileMessageSeverity}>{profileMessage}</Alert>
              ) : null}
              <TextField
                label="Name"
                name="displayName"
                autoComplete="name"
                fullWidth
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setProfileMessage(null);
                }}
                helperText="Shown in the app header."
              />
              <TextField
                label="Email"
                name="email"
                type="email"
                autoComplete="email"
                required
                fullWidth
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setProfileMessage(null);
                }}
                helperText={
                  pendingEmail
                    ? `Confirmation pending for ${pendingEmail}. Your login email stays ${accountEmail} until both links are confirmed.`
                    : "Used to sign in. Changing it emails confirmation links to both addresses."
                }
              />
              <Button
                type="submit"
                variant="contained"
                disabled={profileMutation.isPending || !profileDirty}
                sx={{ alignSelf: "flex-start" }}
              >
                Save profile
              </Button>
            </Stack>
          </Section>

          <Section title="Security">
            {!changePasswordOpen ? (
              <Button
                variant="outlined"
                onClick={() => {
                  setChangePasswordOpen(true);
                  passwordMutation.reset();
                }}
              >
                Change password
              </Button>
            ) : (
              <Stack
                component="form"
                spacing={2}
                onSubmit={(event) => {
                  event.preventDefault();
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
                <Stack direction="row" spacing={1.5}>
                  <Button type="submit" variant="contained" disabled={passwordMutation.isPending}>
                    Save new password
                  </Button>
                  <Button
                    type="button"
                    variant="text"
                    color="inherit"
                    disabled={passwordMutation.isPending}
                    onClick={() => {
                      setChangePasswordOpen(false);
                      setCurrentPassword("");
                      setNextPassword("");
                      setConfirmPassword("");
                      passwordMutation.reset();
                    }}
                  >
                    Cancel
                  </Button>
                </Stack>
                <Typography variant="body2" color="text.secondary">
                  Changing your password signs you out of other sessions.
                </Typography>
              </Stack>
            )}
          </Section>

          <Box sx={{ pt: 2 }}>
            <Section title="Danger zone" danger>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Permanently delete your account and API key. An already-open checkout may
                still accept payment afterward, but that payment will not recreate your
                account or access and Devneya will not compensate it.
              </Typography>
              {!deleteOpen ? (
                <Button
                  variant="outlined"
                  color="inherit"
                  onClick={() => {
                    setDeleteOpen(true);
                    setDeleteEmail("");
                    setDeleteError(null);
                    deleteMutation.reset();
                  }}
                  sx={{
                    borderColor: brand.hairline,
                    color: brand.muted,
                    "&:hover": {
                      borderColor: brand.ink,
                      color: brand.ink,
                      bgcolor: brand.soft,
                    },
                  }}
                >
                  Delete account
                </Button>
              ) : (
                <Stack
                  component="form"
                  spacing={2}
                  onSubmit={(event) => {
                    event.preventDefault();
                    setDeleteError(null);
                    if (deleteEmail.trim().toLowerCase() !== accountEmail.toLowerCase()) {
                      setDeleteError("Email does not match this account.");
                      return;
                    }
                    deleteMutation.mutate();
                  }}
                >
                  <Typography variant="body2" color="text.secondary">
                    Type <strong>{accountEmail || "your email"}</strong> to confirm.
                  </Typography>
                  {deleteError ? <Alert severity="error">{deleteError}</Alert> : null}
                  <TextField
                    label="Account email"
                    type="email"
                    autoComplete="email"
                    required
                    fullWidth
                    value={deleteEmail}
                    onChange={(e) => setDeleteEmail(e.target.value)}
                  />
                  <Stack direction="row" spacing={1.5}>
                    <Button
                      type="submit"
                      variant="outlined"
                      color="inherit"
                      disabled={deleteMutation.isPending || !deleteEmail.trim()}
                      sx={{
                        borderColor: brand.hairline,
                        color: brand.ink,
                        "&:hover": {
                          borderColor: brand.ink,
                          bgcolor: brand.soft,
                        },
                      }}
                    >
                      Confirm delete
                    </Button>
                    <Button
                      type="button"
                      variant="text"
                      color="inherit"
                      disabled={deleteMutation.isPending}
                      onClick={() => {
                        setDeleteOpen(false);
                        setDeleteEmail("");
                        setDeleteError(null);
                        deleteMutation.reset();
                      }}
                    >
                      Cancel
                    </Button>
                  </Stack>
                </Stack>
              )}
            </Section>
          </Box>
        </Stack>
      </Container>
    </>
  );
}
