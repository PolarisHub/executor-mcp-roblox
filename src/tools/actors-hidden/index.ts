import type { Tool } from "../../application/tool/tool.js";
import findHiddenScripts from "./find-hidden-scripts.js";
import listActors from "./list-actors.js";
import getNilInstances from "./get-nil-instances.js";
import findRunningScripts from "./find-running-scripts.js";
import findHiddenInstances from "./find-hidden-instances.js";
import findHiddenGuis from "./find-hidden-guis.js";
import summarizeHiddenSurfaces from "./summarize-hidden-surfaces.js";
import findHiddenRemotes from "./find-hidden-remotes.js";
import getActorDetails from "./get-actor-details.js";
import findDetachedInstances from "./find-detached-instances.js";
import { actorStateTools } from "./actor-state.js";

/** Every Actors & Hidden tool, from read-only discovery through confirmed Actor/state operations. */
export const actorsHiddenTools: Tool[] = [
  findHiddenScripts,
  listActors,
  getNilInstances,
  findRunningScripts,
  findHiddenInstances,
  findHiddenGuis,
  summarizeHiddenSurfaces,
  findHiddenRemotes,
  getActorDetails,
  findDetachedInstances,
  ...actorStateTools,
];
