import type { VercelRequest, VercelResponse } from "../_lib/http.js";
import { contractAddress, isConfigured } from "../_lib/genlayer.js";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  const address = contractAddress();
  res.status(200).json({
    configured: isConfigured(),
    contract: address || null,
    explorer: address
      ? `https://explorer-studio.genlayer.com/address/${address}`
      : null,
  });
}
