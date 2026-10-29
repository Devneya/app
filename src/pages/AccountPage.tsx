import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Alert, Box, Button, Container, Stack, TextField, Typography } from "@mui/material";
import { useAuth } from "@/auth/useAuth";
import { deleteAccount, logout } from "@/api/account";
import { describeError } from "@/api/errors";
import { AppChrome } from "@/components/AppChrome";
import { Section } from "@/components/Section";
import { brand } from "@/theme";

function readSavedName(session: ReturnType<typeof useAuth>["session"]): string {
  const name = session?.user?.user_metadata?.name;
  return typeof name === "string" ? name : "";
}

type PasswordStage = "none" | "password_changed" | "backend_logged_out";

export function AccountPage() {
  const { session, sessionGeneration, isSessionCurrent, isSessionUsable, completeSession, changePassword, updateDisplayName, updateEmail } = useAuth();
  const navigate = useNavigate();
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
  const [passwordFields, setPasswordFields] = useState({ owner: sessionGeneration, current: "", next: "", confirm: "" });
  const fields = passwordFields.owner === sessionGeneration && isSessionUsable(sessionGeneration) ? passwordFields : { owner: sessionGeneration, current: "", next: "", confirm: "" };
  const { current: currentPassword, next: nextPassword, confirm: confirmPassword } = fields;
  const setCurrentPassword = (value: string) => setPasswordFields({ ...fields, current: value });
  const setNextPassword = (value: string) => setPasswordFields({ ...fields, next: value });
  const setConfirmPassword = (value: string) => setPasswordFields({ ...fields, confirm: value });
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [deleteOpenOwner, setDeleteOpenOwner] = useState<number | null>(null);
  const deleteOpen = deleteOpenOwner === sessionGeneration;
  const [deleteEmail, setDeleteEmail] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletionOwner, setDeletionOwner] = useState<number | null>(null);
  const deletionCompleted = deletionOwner === sessionGeneration && isSessionUsable(sessionGeneration);
  const [passwordProgress, setPasswordProgress] = useState<{ owner: number; stage: PasswordStage } | null>(null);
  const passwordStage = passwordProgress?.owner === sessionGeneration && isSessionUsable(sessionGeneration) ? passwordProgress.stage : "none";
  const [deleteMutationOwner, setDeleteMutationOwner] = useState<number | null>(null);
  const [passwordMutationOwner, setPasswordMutationOwner] = useState<number | null>(null);
  const passwordLogoutTokenRef = useRef<{ owner: number; token: string } | null>(null);

  const nameDirty = displayName.trim() !== savedName.trim();
  const emailDirty = email.trim().toLowerCase() !== accountEmail.toLowerCase();
  const profileDirty = nameDirty || emailDirty;

  const profileMutation = useMutation({
    mutationFn: async () => {
      const nextName = displayName.trim();
      const nextEmail = email.trim();
      if (!nextEmail) {
        throw new Error("Email is required");
      }
      const nameChanged = nameDirty;
      const emailChanged = emailDirty;
      if (nameChanged) {
        await updateDisplayName(nextName);
      }
      if (emailChanged) {
        await updateEmail(nextEmail);
      }
      return { nameChanged, emailChanged, nextEmail };
    },
    onSuccess: (result) => {
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
      const owner = sessionGeneration;
      setDeleteMutationOwner(owner);
      if (!deletionCompleted) {
        if (!isSessionUsable(owner)) return false;
        await deleteAccount(token);
        if (!isSessionCurrent(owner)) return false;
        setDeletionOwner(owner);
      }
      return completeSession("Account deletion", owner);
    },
    onSuccess: (completed) => { if (completed) navigate("/login"); },
  });

  const passwordMutation = useMutation({
    mutationFn: async () => {
      let owner = sessionGeneration;
      setPasswordMutationOwner(owner);
      let stage = passwordStage;
      if (stage === "none") {
        if (nextPassword.length < 6) {
          throw new Error("Password must be at least 6 characters.");
        }
        if (nextPassword !== confirmPassword) {
          throw new Error("Passwords do not match.");
        }
        const result = await changePassword(currentPassword, nextPassword, owner);
        if (!result) return false;
        owner = result.originGeneration;
        setPasswordMutationOwner(owner);
        if (!isSessionCurrent(owner)) return false;
        passwordLogoutTokenRef.current = { owner, token: result.sessionToken };
        stage = "password_changed";
        setPasswordProgress({ owner, stage });
      }
      if (stage === "password_changed") {
        const currentToken = passwordLogoutTokenRef.current;
        if (!currentToken || currentToken.owner !== owner) {
          throw new Error("Password change recovery state is missing.");
        }
        if (!isSessionUsable(owner)) return false;
        await logout(currentToken.token);
        if (!isSessionCurrent(owner)) return false;
        stage = "backend_logged_out";
        setPasswordProgress({ owner, stage });
      }
      if (stage === "backend_logged_out") {
        const completed = await completeSession("Password change", owner);
        if (!isSessionCurrent(owner)) return false;
        sessionStorage.setItem("devneya.passwordChanged", "1");
        return completed;
      }
    },
    onSuccess: (completed) => {
      if (completed) navigate("/login", { replace: true });
    },
  });

  return (
    <>
      <AppChrome section="account" />

      <Container maxWidth="md" sx={{ mt: 4, mb: 6 }}>
        <Stack spacing={3}>
          {deleteMutation.error && deleteMutationOwner === sessionGeneration && isSessionUsable(sessionGeneration) && !deletionCompleted ? (
            <Alert severity="error">
              {describeError(deleteMutation.error, "Could not delete account")}
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
                  {describeError(profileMutation.error, "Could not save profile")}
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
                {passwordMutation.error && passwordMutationOwner === sessionGeneration && isSessionUsable(sessionGeneration) ? (
                  <Alert severity="error">
                    {passwordStage === "backend_logged_out"
                      ? `Password changed and backend logout completed, but local sign-out failed: ${describeError(passwordMutation.error)}`
                      : passwordStage === "password_changed"
                        ? `Password changed, but backend logout failed: ${describeError(passwordMutation.error)}`
                        : describeError(passwordMutation.error, "Could not change password")}
                  </Alert>
                ) : null}
                {passwordStage === "none" ? (
                  <>
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
                  </>
                ) : null}
                <Stack direction="row" spacing={1.5}>
                  <Button type="submit" variant="contained" disabled={passwordMutation.isPending}>
                    {passwordStage === "none"
                      ? "Save new password"
                      : passwordStage === "password_changed"
                        ? "Finish password change"
                        : "Finish local sign-out"}
                  </Button>
                  <Button
                    type="button"
                    variant="text"
                    color="inherit"
                    disabled={passwordMutation.isPending}
                    onClick={() => {
                      setChangePasswordOpen(false);
                      if (passwordStage === "none") {
                        setPasswordFields({ owner: sessionGeneration, current: "", next: "", confirm: "" });
                        passwordMutation.reset();
                      }
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
              {deletionCompleted ? (
                <Stack spacing={2}>
                  <Alert severity="warning">
                    Account deletion completed, but local sign-out failed. Finish local
                    sign-out to leave this account.
                    {deleteMutation.error ? ` ${describeError(deleteMutation.error)}` : ""}
                  </Alert>
                  <Button
                    variant="contained"
                    color="warning"
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate()}
                    sx={{ alignSelf: "flex-start" }}
                  >
                    Finish local sign-out
                  </Button>
                </Stack>
              ) : !deleteOpen ? (
                <Button
                  variant="outlined"
                  color="inherit"
                  onClick={() => {
                    setDeleteOpenOwner(sessionGeneration);
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
                        setDeleteOpenOwner(null);
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
