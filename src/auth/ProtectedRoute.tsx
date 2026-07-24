import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "@/auth/useAuth";
import { CircularProgress, Box } from "@mui/material";

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", mt: 8 }}>
        <CircularProgress aria-label="Loading session" />
      </Box>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return children;
}
