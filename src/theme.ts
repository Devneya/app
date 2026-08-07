import { createTheme } from "@mui/material/styles";

/**
 * Lightweight “bones” tokens — closer to opencode.ai:
 * warm cream canvas, near-black ink, monospace, hairlines, no playful chrome.
 */
export const brand = {
  ink: "#201d1d",
  canvas: "#fdfcfc",
  paper: "#fdfcfc",
  soft: "#f4f2f2",
  muted: "#9a9898",
  hairline: "rgba(15, 0, 0, 0.12)",
  /** Light brand accent — used sparingly (focus, markers, progress). */
  yellow: "#ffc108",
  yellowSoft: "#fff8e1",
  blue: "#007aff",
  red: "#ff3b30",
  green: "#30d158",
  orange: "#ff9f0a",
} as const;

const mono = '"IBM Plex Mono", "ui-monospace", "SFMono-Regular", Menlo, Consolas, monospace';

export const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: brand.ink,
      contrastText: brand.canvas,
    },
    secondary: {
      main: brand.yellow,
      light: brand.yellowSoft,
      contrastText: brand.ink,
    },
    error: {
      main: brand.red,
    },
    warning: {
      main: brand.orange,
      contrastText: brand.ink,
    },
    success: {
      main: brand.green,
      contrastText: brand.ink,
    },
    info: {
      main: brand.blue,
      contrastText: brand.canvas,
    },
    text: {
      primary: brand.ink,
      secondary: brand.muted,
    },
    background: {
      default: brand.canvas,
      paper: brand.paper,
    },
    divider: brand.hairline,
  },
  typography: {
    fontFamily: mono,
    allVariants: {
      letterSpacing: "-0.01em",
    },
    h1: { fontWeight: 700, fontSize: "1.75rem", lineHeight: 1.35 },
    h4: { fontWeight: 700, fontSize: "1.5rem", lineHeight: 1.35 },
    h5: { fontWeight: 600, fontSize: "1.15rem", lineHeight: 1.4 },
    h6: { fontWeight: 600, fontSize: "0.95rem", lineHeight: 1.4 },
    body1: { fontWeight: 400, fontSize: "0.9375rem", lineHeight: 1.55 },
    body2: { fontWeight: 400, fontSize: "0.8125rem", lineHeight: 1.5 },
    button: {
      textTransform: "none",
      fontWeight: 500,
      fontSize: "0.875rem",
    },
  },
  shape: {
    borderRadius: 4,
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: brand.canvas,
          backgroundImage: "none",
          minHeight: "100vh",
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
      styleOverrides: {
        root: ({ ownerState }) => ({
          borderRadius: 4,
          boxShadow: "none",
          ...(ownerState.variant === "contained" &&
            ownerState.color === "primary" && {
              backgroundColor: brand.ink,
              color: brand.canvas,
              "&:hover": {
                backgroundColor: "#000000",
                boxShadow: "none",
              },
            }),
          ...(ownerState.variant === "outlined" && {
            borderColor: brand.hairline,
            backgroundColor: "transparent",
          }),
          "&:hover": {
            boxShadow: "none",
          },
        }),
      },
    },
    MuiTextField: {
      defaultProps: {
        variant: "outlined",
        size: "small",
      },
    },
    MuiInputLabel: {
      styleOverrides: {
        root: {
          letterSpacing: 0,
        },
        // Keep labels above the field (no floating notch) — mono metrics
        // otherwise slice through the outlined border.
        outlined: {
          position: "relative",
          transform: "none",
          marginBottom: 10,
          maxWidth: "100%",
          pointerEvents: "auto",
          color: brand.muted,
          lineHeight: 1.4,
          "&.Mui-focused": {
            color: brand.ink,
          },
          "&.MuiInputLabel-shrink": {
            transform: "none",
            backgroundColor: "transparent",
            paddingInline: 0,
          },
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: brand.soft,
          borderRadius: 4,
          "&:hover .MuiOutlinedInput-notchedOutline": {
            borderColor: brand.ink,
          },
          "&.Mui-focused": {
            backgroundColor: brand.canvas,
          },
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
            borderColor: brand.yellow,
            borderWidth: 1,
          },
        },
        notchedOutline: {
          borderColor: brand.hairline,
          "& legend": {
            display: "none",
          },
        },
        input: {
          letterSpacing: 0,
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          boxShadow: "none",
          borderBottom: `1px solid ${brand.hairline}`,
          backgroundImage: "none",
        },
      },
    },
    MuiLinearProgress: {
      styleOverrides: {
        root: {
          height: 4,
          borderRadius: 0,
          backgroundColor: brand.soft,
        },
        bar: {
          borderRadius: 0,
          backgroundColor: brand.yellow,
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 4,
          border: `1px solid ${brand.hairline}`,
          boxShadow: "none",
        },
      },
    },
    MuiLink: {
      styleOverrides: {
        root: {
          color: brand.ink,
        },
      },
    },
  },
});
