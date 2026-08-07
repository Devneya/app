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
        py: { xs: 6, sm: 10 },
      }}
    >
      <Box sx={{ maxWidth: 420, width: "100%", mx: "auto" }}>
        <Typography
          component={RouterLink}
          to="/login"
          variant="body2"
          sx={{
            color: brand.ink,
            textDecoration: "none",
            display: "inline-block",
            mb: 3,
            fontWeight: 500,
            borderBottom: `2px solid ${brand.yellow}`,
            pb: 0.35,
          }}
        >
          [Devneya]
        </Typography>

        <Box
          sx={{
            border: `1px solid ${brand.hairline}`,
            borderRadius: 0,
            p: { xs: 3, sm: 3.5 },
            bgcolor: brand.canvas,
          }}
        >
          <Typography
            component="h1"
            variant="h5"
            sx={{
              mb: subtitle ? 0.75 : 3,
              width: "fit-content",
              borderBottom: `2px solid ${brand.yellow}`,
              pb: 0.35,
            }}
          >
            {title}
          </Typography>
          {subtitle ? (
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              {subtitle}
            </Typography>
          ) : null}
          {children}
        </Box>

        <Stack direction="row" spacing={2} sx={{ mt: 3, justifyContent: "center" }}>
          <Typography variant="body2" color="text.secondary">
            <Link href="https://devneya.com" color="inherit" underline="hover">
              [←] devneya.com
            </Link>
          </Typography>
        </Stack>
      </Box>
    </Box>
  );
}
