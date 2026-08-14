function isMissingNotificationsTableError(error) {
  const text = [error?.message, error?.details, error?.hint, error?.code]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!text) return false;
  return (
    text.includes("notifications") &&
    (text.includes("does not exist") ||
      text.includes("relation") ||
      text.includes("schema cache") ||
      text.includes("could not find the table") ||
      text.includes("public.notifications"))
  );
}

module.exports = { isMissingNotificationsTableError };
