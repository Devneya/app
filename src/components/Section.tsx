import { Box, Typography } from "@mui/material";
import { brand } from "@/theme";

export function Section({
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
        bgcolor: "transparent",
        border: `1px solid ${danger ? "rgba(15, 0, 0, 0.18)" : brand.hairline}`,
        borderRadius: 0,
        p: 3,
        ...(danger
          ? {
              mt: 2,
              pt: 3,
              borderStyle: "dashed",
            }
          : {}),
      }}
    >
      <Typography
        variant="h6"
        gutterBottom
        color={danger ? "error.main" : "text.primary"}
        sx={{
          fontWeight: 600,
          width: "fit-content",
          borderBottom: `2px solid ${danger ? brand.red : brand.yellow}`,
          pb: 0.35,
          mb: 2,
        }}
      >
        {title}
      </Typography>
      {children}
    </Box>
  );
}
