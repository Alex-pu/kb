export function businessDateForCountry(countryCode: string | undefined, date = new Date()) {
  const timeZone = countryCode === "KE" ? "Africa/Nairobi" : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Could not determine the current business date.");
  return `${year}-${month}-${day}`;
}
