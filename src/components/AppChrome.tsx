import { useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { AppBar, Box, Button, Menu, MenuItem, Toolbar, Typography } from "@mui/material";
import { useAuth } from "@/auth/useAuth";
import { logout } from "@/api/account";
import { brand } from "@/theme";

function accountLabel(session: ReturnType<typeof useAuth>["session"]): string | null {
  const email = session?.user?.email;
  if (!email) {
    return null;
  }
  const name = session.user.user_metadata?.name;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  return email;
}

const navLinkSx = (active: boolean) => ({
  color: active ? brand.ink : "text.secondary",
  textDecoration: "none",
  borderBottom: active ? `1px solid ${brand.yellow}` : "1px solid transparent",
  "&:hover": {
    color: brand.ink,
    borderBottomColor: brand.yellow,
  },
});

export function AppChrome({ section }: { section: "inference" | "account" }) {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const label = accountLabel(session);
  const token = session?.access_token ?? "";
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const menuOpen = Boolean(menuAnchor);

  const logoutMutation = useMutation({
    mutationFn: async () => {
      try {
        await logout(token);
      } catch {
        // Still clear local session if server revoke fails.
      }
      await signOut();
    },
    onSuccess: () => navigate("/login"),
  });

  function closeMenu() {
    setMenuAnchor(null);
  }

  return (
    <AppBar
      position="static"
      color="transparent"
      elevation={0}
      sx={{
        bgcolor: brand.canvas,
        borderBottom: `1px solid ${brand.hairline}`,
      }}
    >
      <Toolbar sx={{ gap: 2, minHeight: 56 }}>
        <Typography variant="body2" component="div" sx={{ flexGrow: 1, fontWeight: 500 }}>
          <Box
            component={RouterLink}
            to="/"
            sx={{
              color: "inherit",
              textDecoration: "none",
              borderBottom: `2px solid ${brand.yellow}`,
              pb: 0.25,
            }}
          >
            [Devneya]
          </Box>
        </Typography>
        <Typography
          component={RouterLink}
          to="/"
          variant="body2"
          sx={navLinkSx(section === "inference")}
        >
          LLM inference
        </Typography>
        {label ? (
          <>
            <Button
              color="inherit"
              size="small"
              onClick={(event) => setMenuAnchor(event.currentTarget)}
              aria-label={
                session?.user?.email ? `Account menu: ${session.user.email}` : "Account menu"
              }
              aria-haspopup="menu"
              aria-expanded={menuOpen ? "true" : undefined}
              aria-controls={menuOpen ? "account-menu" : undefined}
              sx={{
                color: section === "account" ? brand.ink : "text.secondary",
                textTransform: "none",
                fontWeight: 400,
                minWidth: 0,
                px: 0.5,
                borderRadius: 0,
                borderBottom:
                  section === "account" ? `1px solid ${brand.yellow}` : "1px solid transparent",
                "&:hover": {
                  color: brand.ink,
                  bgcolor: "transparent",
                  borderBottomColor: brand.yellow,
                },
              }}
            >
              {label}
            </Button>
            <Menu
              id="account-menu"
              anchorEl={menuAnchor}
              open={menuOpen}
              onClose={closeMenu}
              anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
              transformOrigin={{ vertical: "top", horizontal: "right" }}
              slotProps={{
                paper: {
                  sx: {
                    mt: 1,
                    minWidth: 160,
                    borderRadius: 0,
                    border: `1px solid ${brand.hairline}`,
                    boxShadow: "none",
                  },
                },
              }}
            >
              <MenuItem
                component={RouterLink}
                to="/account"
                selected={section === "account"}
                onClick={closeMenu}
              >
                Profile
              </MenuItem>
              <MenuItem
                disabled={logoutMutation.isPending}
                onClick={() => {
                  closeMenu();
                  logoutMutation.mutate();
                }}
              >
                Log out
              </MenuItem>
            </Menu>
          </>
        ) : null}
      </Toolbar>
    </AppBar>
  );
}
