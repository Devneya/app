export async function completeLocalSignOut(
  signOut: () => Promise<void>,
  clearQueries: () => void,
): Promise<void> {
  await signOut();
  clearQueries();
}
