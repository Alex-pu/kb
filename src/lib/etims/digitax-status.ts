export function isDigitaxItemComplete(status: string | null | undefined): boolean {
  const normalized = status?.trim().toUpperCase();
  return normalized === "COMPLETE" || normalized === "COMPLETED";
}
