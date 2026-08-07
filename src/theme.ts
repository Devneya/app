import { createTheme } from "@mui/material/styles";

/** Brand tokens aligned with devneya.com / playground (black + yellow). */
export const brand = {
  black: "#111111",
  yellow: "#ffc108",
  yellowHover: "#f5b908",
  paper: "#ffffff",
  canvas: "#f5f5f5",
  muted: "#666666",
} as const;

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: brand.black,
      contrastText: "#ffffff",
    },
    secondary: {
      main: brand.yellow,
      dark: brand.yellowHover,
      contrastText: brand.black,
    },
    text: {
      primary: brand.black,
      secondary: brand.muted,
    },
    background: {
      default: brand.canvas,
      paper: brand.paper,
    },
  },
  typography: {
    fontFamily: '"Roboto Condensed", "Helvetica", "Arial", sans-serif',
    h1: {
      fontFamily: '"Monomaniac One", "Roboto Condensed", sans-serif',
      fontWeight: 400,
    },
    h4: {
      fontFamily: '"Monomaniac One", "Roboto Condensed", sans-serif',
      fontWeight: 400,
    },
    h6: {
      fontFamily: '"Roboto Condensed", sans-serif',
      fontWeight: 500,
    },
    button: {
      textTransform: "none",
      fontWeight: 500,
    },
  },
  shape: {
    borderRadius: 8,
  },
  components: {
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: ({ ownerState }) =>
          ownerState.variant === "contained" && ownerState.color === "primary"
            ? {
                boxShadow: `3px 3px 0 ${brand.yellow}`,
                "&:hover": {
                  boxShadow: `3px 3px 0 ${brand.yellowHover}`,
                  backgroundColor: "#000000",
                },
              }
            : ownerState.variant === "contained" && ownerState.color === "secondary"
              ? { fontWeight: 600 }
              : {},
      },
    },
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundImage:
            "radial-gradient(ellipse at top, rgba(255,193,8,0.12), transparent 55%), linear-gradient(180deg, #fafafa 0%, #f0f0f0 100%)",
          backgroundAttachment: "fixed",
          minHeight: "100vh",
        },
      },
    },
  },
});
