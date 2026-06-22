import type { Tool } from "../../application/tool/tool.js";

import listRemotes from "./list-remotes.js";
import getRemoteSignature from "./get-remote-signature.js";
import monitorRemote from "./monitor-remote.js";
import traceRemoteTraffic from "./trace-remote-traffic.js";
import inspectCallbacks from "./inspect-callbacks.js";
import ensureRemoteSpy from "./ensure-remote-spy.js";
import getRemoteSpyLogs from "./get-remote-spy-logs.js";
import clearRemoteSpyLogs from "./clear-remote-spy-logs.js";
import blockRemote from "./block-remote.js";
import ignoreRemote from "./ignore-remote.js";

/** Every tool in the Remote Spy category, in migration order. */
export const remoteSpyTools: Tool[] = [
  // GROUP A — ported verbatim from _legacy (get-data-by-code Luau kept intact).
  listRemotes,
  getRemoteSignature,
  monitorRemote,
  traceRemoteTraffic,
  inspectCallbacks,
  // GROUP B — reimplemented self-contained (legacy ones were Cobalt connector wrappers).
  ensureRemoteSpy,
  getRemoteSpyLogs,
  clearRemoteSpyLogs,
  blockRemote,
  ignoreRemote,
];
