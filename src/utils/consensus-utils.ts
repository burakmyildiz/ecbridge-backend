// ECBridge/backend/src/utils/consensus-utils.ts

// Use static import - requires node-fetch@2 to be installed (npm install node-fetch@2)
import fetch from 'node-fetch';
import { TransactionStatus, ITransaction } from '../models'; // Assuming ITransaction is the correct type
import { slotToELBlock } from './slotHelper';
import { ethers } from 'ethers'; // Import ethers Provider type if needed

// --- Define Interfaces for Beacon API Responses ---

// Structure for successful /eth/v1/beacon/headers/{block_id} response
interface BeaconHeaderData {
  header: {
    message: {
      slot: string; // Slot number is typically a string in API responses
      // Add other fields if needed
    };
    // Add other fields if needed
  };
  // Add other fields if needed
}

interface BeaconHeaderResponse {
  data: BeaconHeaderData;
  // Add other top-level fields if needed
}

// Potential structure for an error response from the Beacon API
interface BeaconErrorResponse {
  message?: string; // Error message might be optional
  code?: number;
  // Add other potential error fields
}

// Type guard to check if an object conforms to BeaconHeaderResponse
function isBeaconHeaderResponse(obj: unknown): obj is BeaconHeaderResponse {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'data' in obj &&
    typeof obj.data === 'object' &&
    obj.data !== null &&
    'header' in obj.data &&
    typeof obj.data.header === 'object' &&
    obj.data.header !== null &&
    'message' in obj.data.header &&
    typeof obj.data.header.message === 'object' &&
    obj.data.header.message !== null &&
    'slot' in obj.data.header.message &&
    typeof obj.data.header.message.slot === 'string'
  );
}

// Type guard for error response
function isBeaconErrorResponse(obj: unknown): obj is BeaconErrorResponse {
    return (
        typeof obj === 'object' &&
        obj !== null &&
        // Check if it has common error fields like message or code
        (typeof (obj as BeaconErrorResponse).message === 'string' || typeof (obj as BeaconErrorResponse).code === 'number')
    );
}


/**
 * Calculates the finality status of an L1 deposit block using Beacon API.
 * @param depositBlockNumber The L1 block number of the deposit.
 * @param transaction The transaction object from the database (used for status check).
 * @param l1Provider An ethers Provider instance for the L1 execution layer.
 * @returns An object indicating the finality phase, ETA, and percentage.
 */
export async function getBestFinalityStatus(
    depositBlockNumber: number,
    transaction: ITransaction, // Use the specific ITransaction type
    l1Provider: ethers.JsonRpcProvider // Updated for ethers v6
): Promise<{ phase: string; etaSeconds: number; pct: number }> {
  const consensusRpcUrl = process.env.SOURCE_CONSENSUS_RPC_URL;

  if (!consensusRpcUrl) {
      console.error("SOURCE_CONSENSUS_RPC_URL not configured!");
      // Return a default pending status if RPC is missing
      return { phase: "PENDING_CONFIG", etaSeconds: 900, pct: 0 };
  }

  try {
    // Static import 'fetch' from 'node-fetch@2' is used here

    // Get the latest finalized header from the beacon chain
    const response = await fetch(`${consensusRpcUrl}/eth/v1/beacon/headers/finalized`);
    // For node-fetch@2, response.json() returns Promise<any>, so we cast
    const responseBody: unknown = await response.json();

    if (!response.ok) {
        let errorMessage = response.statusText;
        // Try to extract message from known error structure
        if (isBeaconErrorResponse(responseBody) && responseBody.message) {
            errorMessage = responseBody.message;
        }
        // Throw the error with the extracted message or status text
        throw new Error(`Beacon API error (${response.status}): ${errorMessage}`);
    }

    // --- Type Check for Success Response ---
    if (!isBeaconHeaderResponse(responseBody)) {
        console.error("Unexpected Beacon API response structure:", responseBody);
        throw new Error("Unexpected Beacon API response structure for finalized header.");
    }

    // Now TypeScript knows the structure, safely access properties
    const finalizedSlot = parseInt(responseBody.data.header.message.slot, 10);
    if (isNaN(finalizedSlot)) {
        throw new Error("Failed to parse finalized slot from Beacon API response.");
    }

    // Get execution block corresponding to the finalized slot
    const blockInfo = await slotToELBlock(
      consensusRpcUrl, // Pass validated URL
      l1Provider,
      finalizedSlot
    );

    const finalizedBlockNumber = blockInfo.number;

    // --- Calculate Finality Status ---
    if (depositBlockNumber <= finalizedBlockNumber) {
      // Block is already finalized according to the beacon chain state
      if (transaction.status === TransactionStatus.CONFIRMED) {
        // If already confirmed in our system, it's effectively "Minted" or "Completed"
        return { phase: "MINTED", etaSeconds: 0, pct: 100 };
      }
      // Otherwise, it's finalized but not yet processed/confirmed by the bridge
      return { phase: "FINALIZED", etaSeconds: 30, pct: 90 }; // Short ETA for processing
    }

    // Block is not yet finalized
    const blocksRemaining = depositBlockNumber - finalizedBlockNumber;
    const slotTimeSeconds = 12; // Assume 12 seconds per slot
    // Estimate ETA based on remaining blocks and slot time
    const etaSeconds = Math.max(10, blocksRemaining * slotTimeSeconds);
    // Calculate percentage (heuristic: 0-75% during finalization wait)
    // This assumes roughly 32 blocks (~6.4 mins) for finality, adjust if needed
    const finalityWindowBlocks = 32 * 2; // Approx blocks in 2 epochs (standard finality)
    const blocksIntoFinality = finalizedBlockNumber - (depositBlockNumber - finalityWindowBlocks);
    const pct = Math.min(75, Math.max(0, (blocksIntoFinality / finalityWindowBlocks) * 75));

    return { phase: "UNFINALIZED", etaSeconds, pct };

  } catch (error: any) {
    console.error("Error getting consensus finality status:", error.message);
    // Return a generic pending/error status if API call fails
    return { phase: "PENDING_ERROR", etaSeconds: 900, pct: 0 };
  }
}
