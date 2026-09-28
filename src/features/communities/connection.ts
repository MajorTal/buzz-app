import { nativeIdentityEnabled } from "../identity/service";
import { connectNativeTransport } from "../relay/native";
import {
  connectBrokerTransport,
  registerBrokerCommunity,
} from "../relay/transport";
import { communityDestination } from "./destination";

export function registerCommunity(id: string, signal?: AbortSignal) {
  if (nativeIdentityEnabled()) {
    communityDestination(id);
    signal?.throwIfAborted();
    return Promise.resolve();
  }
  return registerBrokerCommunity(id, signal);
}

export function connectCommunityTransport(id: string, signal?: AbortSignal) {
  return nativeIdentityEnabled()
    ? connectNativeTransport(id, signal)
    : connectBrokerTransport("", signal, id);
}
