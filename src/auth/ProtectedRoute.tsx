import { Navigate } from "react-router-dom";
import { useAuth } from "@/auth/useAuth";
import { Alert, CircularProgress, Box } from "@mui/material";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, loading, initializationError } = useAuth();

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", mt: 8 }}>
        <CircularProgress aria-label="Loading session" />
      </Box>
    );
  }

  if (initializationError && !session) {
    return (
      <Box sx={{ maxWidth: 560, mx: "auto", mt: 8, px: 2 }}>
        <Alert severity="error">Could not load your session: {initializationError.message}</Alert>
      </Box>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  return children;
}
