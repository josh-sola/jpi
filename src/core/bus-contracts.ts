import { isRecord } from "./guards.ts";

// jpi-background's tasks-level channel. Level semantics, replace-set: each
// payload is the full current running set. jpi-sidebar and jpi-planter read
// this channel directly — the string value is an external contract.
export const TASKS_CHANNEL = "jpi-background:tasks:v1";
export const TASKS_SCHEMA = "jpi-background.tasks.v1";

export function jpiBackgroundRunningIds(data: unknown): Set<string> | undefined {
  if (!isRecord(data) || data.schema !== TASKS_SCHEMA || !Array.isArray(data.tasks)) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const task of data.tasks) {
    if (isRecord(task) && typeof task.id === "string" && task.id) ids.add(task.id);
  }
  return ids;
}

// jpi-schedule's schedules-level channel. Level semantics, replace-set: each
// payload is the full current set of armed schedules. jpi-title reads this
// channel directly — the string value is an external contract.
export const SCHEDULES_CHANNEL = "jpi-schedule:schedules:v1";
export const SCHEDULES_SCHEMA = "jpi-schedule.schedules.v1";

export function scheduleIds(data: unknown): Set<string> | undefined {
  if (!isRecord(data) || data.schema !== SCHEDULES_SCHEMA || !Array.isArray(data.schedules)) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const schedule of data.schedules) {
    if (isRecord(schedule) && typeof schedule.id === "string" && schedule.id) ids.add(schedule.id);
  }
  return ids;
}

// jpi-subagents' fleet-render handshake, received over `pi.events`. Neither
// side importing the other's module is the point — this pair of constants and
// the payload shape are the whole contract between them.
export const FLEET_PROVIDER_CHANNEL = "subagents:fleet:provider:v1";
export const FLEET_CONSUMER_READY_CHANNEL = "subagents:fleet:consumer-ready:v1";

export type FleetProviderPayload<Theme = unknown> = {
  schema: "subagents.fleet.provider.v1";
  render(width: number, theme: Theme): string[];
  attach(consumer: { requestRender(): void; getFocusedComponent?(): unknown }): () => void;
};

export function isFleetProviderPayload(data: unknown): data is FleetProviderPayload {
  if (typeof data !== "object" || data === null) return false;
  const candidate = data as Record<string, unknown>;
  return (
    candidate.schema === "subagents.fleet.provider.v1" &&
    typeof candidate.render === "function" &&
    typeof candidate.attach === "function"
  );
}
