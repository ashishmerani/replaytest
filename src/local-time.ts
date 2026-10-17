/** Formats a recorded instant for the machine running the renderer. */
export function formatLocalTime(iso: string, includeTimeZone = true): string {
  const timestamp = new Date(iso);
  if (Number.isNaN(timestamp.valueOf())) return iso;
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  };
  if (includeTimeZone) options.timeZoneName = 'short';
  return timestamp.toLocaleString(undefined, options);
}
