/**
 * fleet-footer-bridge.ts — hands jpi-status a render provider for the fleet
 * list over `pi.events`, so the fleet rows can draw below the status footer
 * instead of the default `belowEditor` widget.
 *
 * Load-order-independent handshake: this side emits the provider on its own
 * `session_start` and again on every consumer-ready, and jpi-status emits
 * consumer-ready on its own `session_start` after subscribing to the provider
 * channel — so whichever extension's `session_start` runs first, the other's
 * emit still reaches a live listener.
 *
 * The channels and payload shape live in src/core so this module and
 * jpi-status can each consume them without depending on the other.
 */

import {
  FLEET_CONSUMER_READY_CHANNEL,
  FLEET_PROVIDER_CHANNEL,
  type FleetProviderPayload as CoreFleetProviderPayload,
} from "../../src/core/index.ts";
import type { WidgetTheme } from "../../src/pi/index.ts";
import type { EventBus } from "./cross-extension-rpc.ts";
import type { FleetList } from "./ui/fleet-list.ts";

export { FLEET_CONSUMER_READY_CHANNEL, FLEET_PROVIDER_CHANNEL };

export type FleetProviderPayload = CoreFleetProviderPayload<WidgetTheme>;

/**
 * Emit the fleet render provider on `FLEET_PROVIDER_CHANNEL`, and re-emit it
 * whenever a consumer announces readiness on `FLEET_CONSUMER_READY_CHANNEL`.
 * Returns the unsubscribe for the consumer-ready listener.
 */
export function wireFleetFooterProvider(events: EventBus, fleet: FleetList): () => void {
  const emitProvider = () => {
    const payload: FleetProviderPayload = {
      schema: "subagents.fleet.provider.v1",
      render: (width, theme) => fleet.renderForConsumer(width, theme),
      attach: (consumer) => fleet.attachConsumer(consumer),
    };
    events.emit(FLEET_PROVIDER_CHANNEL, payload);
  };

  emitProvider();
  return events.on(FLEET_CONSUMER_READY_CHANNEL, emitProvider);
}
