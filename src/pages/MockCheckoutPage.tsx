import { Container, Paper, Typography } from "@mui/material";

export function MockCheckoutPage() {
  return (
    <Container maxWidth="sm" sx={{ mt: 8 }}>
      <Paper sx={{ p: 4 }}>
        <Typography component="h1" variant="h5">
          Mock checkout
        </Typography>
        <Typography sx={{ mt: 2 }}>
          Dodo hosted checkout is simulated in mock mode.
        </Typography>
      </Paper>
    </Container>
  );
}
