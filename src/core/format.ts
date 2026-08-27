export function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function truncateMiddle(value: string, maxChars: number, marker: string): string {
  if (value.length <= maxChars) return value;
  const retained = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(retained / 2);
  const tailLength = Math.floor(retained / 2);
  return `${value.slice(0, headLength)}${marker}${value.slice(value.length - tailLength)}`;
}

export interface DurationParts {
  readonly hours: number;
  readonly minutes: number;
  readonly seconds: number;
  readonly fractionalSeconds: number;
}

export function splitDuration(ms: number): DurationParts {
  const totalSeconds = ms / 1000;
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  const fractionalSeconds = totalSeconds - wholeSeconds;
  return { hours, minutes, seconds, fractionalSeconds };
}
