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

/** Every Actors & Hidden tool — read-only discovery of things that hide off the game tree. */
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
];
