import type { ReactNode } from "react";
import { Box, Link, Stack, Typography } from "@mui/material";
import { Link as RouterLink } from "react-router-dom";
import { brand } from "@/theme";

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        px: 2,
        py: { xs: 4, sm: 8 },
      }}
    >
      <Box sx={{ maxWidth: 440, width: "100%", mx: "auto" }}>
        <Stack spacing={1} sx={{ mb: 3 }}>
          <Typography
            component={RouterLink}
            to="/login"
            variant="h4"
            sx={{
              color: brand.black,
              textDecoration: "none",
              width: "fit-content",
            }}
          >
            Devneya
          </Typography>
          <Box
            sx={{
              width: 48,
              height: 4,
              bgcolor: brand.yellow,
              borderRadius: 1,
            }}
          />
        </Stack>

        <Box
          sx={{
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 2,
            p: { xs: 3, sm: 4 },
            boxShadow: `4px 4px 0 ${brand.yellow}`,
          }}
        >
          <Typography component="h1" variant="h5" sx={{ fontWeight: 600, mb: 0.5 }}>
            {title}
          </Typography>
          {subtitle ? (
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              {subtitle}
            </Typography>
          ) : (
            <Box sx={{ mb: 3 }} />
          )}
          {children}
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mt: 3, textAlign: "center" }}>
          <Link href="https://devneya.com" color="inherit" underline="hover">
            Back to devneya.com
          </Link>
        </Typography>
      </Box>
    </Box>
  );
}
