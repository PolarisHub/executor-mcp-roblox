import type { Tool } from "../../application/tool/tool.js";

import listGuiElements from "./list-gui-elements.js";
import getGuiText from "./get-gui-text.js";
import setGuiText from "./set-gui-text.js";
import clickButton from "./click-button.js";
import typeTextBox from "./type-text-box.js";
import fireProximityPrompt from "./fire-proximity-prompt.js";
import fireClickDetector from "./fire-click-detector.js";
import pressKey from "./press-key.js";
import virtualInput from "./virtual-input.js";
import cameraControl from "./camera-control.js";

/** Every tool in the GUI category, in migration order. */
export const guiTools: Tool[] = [
  listGuiElements,
  getGuiText,
  setGuiText,
  clickButton,
  typeTextBox,
  fireProximityPrompt,
  fireClickDetector,
  pressKey,
  virtualInput,
  cameraControl,
];
