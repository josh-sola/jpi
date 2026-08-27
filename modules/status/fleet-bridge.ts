// Wire contract for jpi-subagents' FleetView render provider, received over
// `pi.events`. The channels and payload shape live in src/core so this module
// and jpi-subagents can each consume them without depending on the other.

export {
  FLEET_CONSUMER_READY_CHANNEL,
  FLEET_PROVIDER_CHANNEL,
  type FleetProviderPayload,
  isFleetProviderPayload,
} from "../../src/core/index.ts";

export type FleetConsumer = {
  requestRender(): void;
  getFocusedComponent?(): unknown;
};
