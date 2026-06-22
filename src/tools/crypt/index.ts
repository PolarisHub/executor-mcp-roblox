import type { Tool } from "../../application/tool/tool.js";

import cryptBase64Encode from "./crypt-base64-encode.js";
import cryptBase64Decode from "./crypt-base64-decode.js";
import cryptHash from "./crypt-hash.js";
import cryptEncrypt from "./crypt-encrypt.js";
import cryptDecrypt from "./crypt-decrypt.js";
import cryptGenerateKey from "./crypt-generate-key.js";
import cryptGenerateBytes from "./crypt-generate-bytes.js";

/** Every tool in the Crypt category (executor `crypt` library). */
export const cryptTools: Tool[] = [
  cryptBase64Encode,
  cryptBase64Decode,
  cryptHash,
  cryptEncrypt,
  cryptDecrypt,
  cryptGenerateKey,
  cryptGenerateBytes,
];
