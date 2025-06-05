// backend/src/utils/slotHelper.ts
import { JsonRpcProvider } from "ethers";

/** GET /eth/v2/beacon/blocks/{id} response (post-Capella/Dankshard) */
interface BeaconBlockV2<TPayload = any> {
  data: {
    message: {
      body: {
        execution_payload?: {
          block_hash: string;
        };
        execution_payload_header?: {
          block_hash: string;
        };
      };
    };
  };
}

export interface ELBlockRef {
  number: number;
  hash:   string;
}

/**
 * Convert a beacon slot to the corresponding execution-layer block.
 * Tries /eth/v2/beacon/blocks/{slot} first; falls back to {block_root}.
 */
export async function slotToELBlock(
  consensusRpc: string,
  elProvider: JsonRpcProvider,
  slot: number
): Promise<ELBlockRef> {
  // helper for fetch + JSON parse
  async function getJSON(url: string) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return (await res.json()) as BeaconBlockV2;
  }

  let json: BeaconBlockV2;

  // 1. try by slot
  try {
    json = await getJSON(`${consensusRpc}/eth/v2/beacon/blocks/${slot}`);
  } catch (err) {
    // If slot is not found, try previous slots
    let attempts = 0;
    const maxAttempts = 10;
    let currentSlot = slot;
    
    while (attempts < maxAttempts) {
      attempts++;
      currentSlot--;
      
      try {
        json = await getJSON(`${consensusRpc}/eth/v2/beacon/blocks/${currentSlot}`);
        console.log(`Found beacon block at slot ${currentSlot} (original slot ${slot} was not available)`);
        break;
      } catch (innerErr) {
        if (attempts === maxAttempts) {
          throw new Error(`Could not find beacon block within ${maxAttempts} slots of ${slot}`);
        }
        continue;
      }
    }
    
    if (!json!) {
      throw new Error(`Failed to find beacon block near slot ${slot}`);
    }
  }

  // 2. pull block-hash from execution payload (header or full)
  const body = json.data.message.body;

  const blockHash =
      body.execution_payload?.block_hash
   ?? body.execution_payload_header?.block_hash;

  if (!blockHash) {
    throw new Error(`execution payload hash missing for slot ${slot}`);
  }

  // 3. look up EL block
  const block = await elProvider.getBlock(blockHash);
  if (!block || block.number === null) {
    throw new Error(`EL block not found for hash ${blockHash}`);
  }

  return { number: block.number, hash: block.hash! };
}