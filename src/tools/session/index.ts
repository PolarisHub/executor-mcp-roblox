import type { Tool } from "../../application/tool/tool.js";

import listClients from "./list-clients.js";
import selectClient from "./select-client.js";
import clearSelection from "./clear-selection.js";
import getActiveClient from "./get-active-client.js";
import getPlayers from "./get-players.js";
import getLocalPlayerInfo from "./get-local-player-info.js";
import discoverCharacter from "./discover-character.js";
import getPlaceDetails from "./get-place-details.js";

/** Every tool in the "Session & Client" category, in registration order. */
export const sessionTools: Tool[] = [
  listClients,
  selectClient,
  clearSelection,
  getActiveClient,
  getPlayers,
  getLocalPlayerInfo,
  discoverCharacter,
  getPlaceDetails,
];
