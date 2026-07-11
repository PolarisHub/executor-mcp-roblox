import type { Tool } from "../../application/tool/tool.js";

import getMetatable from "./get-metatable.js";
import getMetamethod from "./get-metamethod.js";
import isReadonly from "./is-readonly.js";
import compareInstances from "./compare-instances.js";
import setMetatableReadonly from "./set-metatable-readonly.js";
import setRawmetatable from "./set-rawmetatable.js";
import hookMetamethod from "./hook-metamethod.js";
import inspectClosure from "./inspect-closure.js";
import getClosureConstants from "./get-closure-constants.js";
import getClosureUpvalues from "./get-closure-upvalues.js";
import getClosureProtos from "./get-closure-protos.js";
import getScriptClosure from "./get-script-closure.js";
import setClosureUpvalue from "./set-closure-upvalue.js";
import setClosureConstant from "./set-closure-constant.js";
import hookFunction from "./hook-function.js";
import getScriptEnv from "./get-script-env.js";
import getFunctionEnv from "./get-function-env.js";
import listHooks from "./list-hooks.js";
import restoreHook from "./restore-hook.js";
import { closurePrimitiveTools } from "./closure-primitives.js";

/** Every tool in the "Metatables & Closures" category, in registration order. */
export const metatablesTools: Tool[] = [
  getMetatable,
  getMetamethod,
  isReadonly,
  compareInstances,
  setMetatableReadonly,
  setRawmetatable,
  hookMetamethod,
  inspectClosure,
  getClosureConstants,
  getClosureUpvalues,
  getClosureProtos,
  getScriptClosure,
  setClosureUpvalue,
  setClosureConstant,
  hookFunction,
  getScriptEnv,
  getFunctionEnv,
  listHooks,
  restoreHook,
  ...closurePrimitiveTools,
];
