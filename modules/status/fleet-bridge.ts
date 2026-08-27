// Wire contract for jpi-subagents' FleetView render provider, received over
// `pi.events`. jpi-subagents owns these channels and the payload shape; this
// file only names them so the footer can consume one without depending on
// that package.

export const FLEET_PROVIDER_CHANNEL = "subagents:fleet:provider:v1";
export const FLEET_CONSUMER_READY_CHANNEL = "subagents:fleet:consumer-ready:v1";

export type FleetConsumer = {
  requestRender(): void;
  getFocusedComponent?(): unknown;
};

export type FleetProviderPayload = {
  schema: "subagents.fleet.provider.v1";
  render(width: number, theme: unknown): string[];
  attach(consumer: FleetConsumer): () => void;
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
