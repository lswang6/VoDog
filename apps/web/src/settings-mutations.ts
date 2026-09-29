/**
 * A settings write is authoritative once Control accepts it. A failed dashboard read afterwards must not make
 * the editing form roll back the returned version or tell the user that the write failed.
 */
export async function acceptSettingsMutation<T>(
  mutate: () => Promise<T>,
  refresh: () => Promise<unknown>,
  onRefreshFailure: (error: unknown) => void,
): Promise<T> {
  const accepted = await mutate();
  try {
    await refresh();
  } catch (error) {
    onRefreshFailure(error);
  }
  return accepted;
}
