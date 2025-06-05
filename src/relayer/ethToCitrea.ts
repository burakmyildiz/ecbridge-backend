// ECBridge/backend/src/relayer/ethToCitrea.ts
import dotenv from "dotenv";
// Ensure .env is loaded correctly, potentially overriding existing process.env vars
// Adjust the path based on your actual project structure relative to this file
dotenv.config({ path: require('path').resolve(__dirname, '../../../.env'), override: true });

import {
  Contract,
  JsonRpcProvider,
  Wallet,
  keccak256,
  ethers,
  EventLog // Import EventLog type
} from "ethers";

// Import ABIs (ensure paths are correct)
import BridgeEthAbi from "../abi/BridgeEth.json";
import BridgeCitreaAbi from "../abi/BridgeCitrea.json";
import SP1HeliosAbi from "../abi/SP1Helios.json";

// Import Utilities (ensure paths are correct)
import { getStorageProof } from "../utils/getStorageProof";
import { slotToELBlock } from "../utils/slotHelper";
import { getBestFinalityStatus } from "../utils/consensus-utils"; // Using consensus finality check

// Import Models and PubSub (ensure paths are correct)
import { TransactionModel, TransactionStatus, Chain, ITransaction } from "../models"; // Import ITransaction type
import { publishTransactionUpdate, publishStatusUpdate } from "../index"; // Assuming index exports these
import logger from "../utils/logger"; // Assuming logger is correctly configured

// --- Configuration & Setup ---
const L1_RPC_URL = process.env.ETH_EXE_RPC_URL;
const L2_RPC_URL = process.env.CITREA_RPC_URL;
const L1_BRIDGE_ADDRESS = process.env.ETH_BRIDGE_ADDRESS;
const L2_BRIDGE_ADDRESS = process.env.CITREA_BRIDGE_ADDRESS;
// SP1Helios address is fetched dynamically later, but keep env var for potential fallback/logging
const L2_HELIOS_ADDRESS_ENV = process.env.SP1_HELIOS_ADDRESS;
const L2_SIGNER_PRIVATE_KEY = process.env.CITREA_PRIVATE_KEY;
const L1_CONSENSUS_RPC_URL = process.env.SOURCE_CONSENSUS_RPC_URL;

// Relayer Behavior Settings
const POLLING_INTERVAL_MS = 15_000; // 15 seconds
const STATUS_UPDATE_INTERVAL_MS = 15_000; // 15 seconds
const L1_BLOCK_CONFIRMATIONS = 1; // How many blocks behind head to process (safety margin)
const SLOT_INTERVAL = 32; // Interval for checking slots with state roots
const FIND_SLOT_SEARCH_RANGE = 500; // How many slots back from latest finalized to search
const READ_HEAD_RETRY_DELAY_MS = 3000; // Delay between retries for reading head (3 seconds)
const READ_HEAD_MAX_RETRIES = 3; // Max attempts to read a non-stale head
const FIND_SLOT_RETRY_DELAY_MS = 30000; // Delay between retries if findAvailableFinalisedSlot fails (30 seconds)
const MAX_FAILED_ATTEMPTS = 3; // Max processing attempts before marking as failed in DB
const SUBMIT_GAS_LIMIT = 1_500_000; // Gas limit for finaliseDeposit tx
const MAX_HEAD_STALENESS_MINUTES = 15; // Max age (in minutes) for the head block timestamp to be considered non-stale

// Validate required environment variables
if (!L1_RPC_URL || !L2_RPC_URL || !L1_BRIDGE_ADDRESS || !L2_BRIDGE_ADDRESS || !L2_SIGNER_PRIVATE_KEY || !L1_CONSENSUS_RPC_URL) {
    logger.error("Missing required environment variables for ethToCitrea relayer. Check L1/L2 RPCs, Bridge Addresses, L2 Private Key, L1 Consensus RPC.");
    process.exit(1); // Exit if essential config is missing
}
if (!L2_HELIOS_ADDRESS_ENV) {
    logger.warn("SP1_HELIOS_ADDRESS env var not set, will rely solely on BridgeCitrea.getLightClient()");
}


// --- Providers & Signer ---
// Use static providers to avoid re-initializing constantly unless necessary
const l1Provider = new JsonRpcProvider(L1_RPC_URL);
const l2Provider = new JsonRpcProvider(L2_RPC_URL);

// L2 Signer Wallet
const l2Wallet = new Wallet(L2_SIGNER_PRIVATE_KEY, l2Provider);
logger.info(`Relayer Wallet (Citrea): ${l2Wallet.address}`);

// L1 Bridge Contract (read-only)
const bridgeEth = new Contract(L1_BRIDGE_ADDRESS, BridgeEthAbi, l1Provider);

// --- Global State ---
const processedDeposits = new Set<number>(); // Nonces confirmed processed on L2
const processingDeposits = new Set<number>(); // Nonces currently being handled in handleDeposit
const failedAttempts = new Map<number, number>(); // nonce -> failure count for runtime retries

// -------- Helpers ----------------------------------------------------------

/**
 * Utility function for delays.
 * @param ms Milliseconds to wait.
 */
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Creates fresh L2 contract instances for BridgeCitrea and SP1Helios.
 * @param heliosAddr The address of the SP1Helios contract.
 * @returns Object containing fresh contract instances.
 */
function getFreshL2Contracts(heliosAddr: string): { bridgeCitreaInstance: Contract, heliosInstance: Contract } {
    // BridgeCitrea instance connected to the signer for sending transactions
    const bridgeCitreaInstance = new Contract(
        L2_BRIDGE_ADDRESS!,
        BridgeCitreaAbi,
        l2Wallet // Use signer
    );
    // SP1Helios instance connected to the provider for view calls
    const heliosInstance = new Contract(
        heliosAddr,
        SP1HeliosAbi,
        l2Provider // Use provider for view calls
    );
    return { bridgeCitreaInstance, heliosInstance };
}

// -------- Core Logic -------------------------------------------------------

/**
 * Finds a suitable finalized slot on the L2 light client for a given L1 deposit block.
 * @param helios Contract instance for SP1Helios.
 * @param depositBlockNumber The L1 block number where the deposit occurred.
 * @param currentHead The current head slot read from the light client (confirmed non-stale).
 * @param minSlotFinality The finality requirement read from BridgeCitrea.
 * @returns The finalized slot number and its state root.
 * @throws If no suitable finalized slot is found within the search range.
 */
async function findAvailableFinalisedSlot(
    helios: Contract,
    depositBlockNumber: number,
    currentHead: number, // Pass in the confirmed head
    minSlotFinality: number // Pass in the confirmed finality
): Promise<{ slot: number; stateRoot: string }> {

    const latestFinalizedSlot = currentHead - minSlotFinality;

    logger.info(`Searching for available finalized slot (<= ${latestFinalizedSlot}) covering block ${depositBlockNumber}`);
    logger.info(`(Using Head: ${currentHead}, Finality: ${minSlotFinality})`);

    // Start search from the latest finalized slot, aligned down to SLOT_INTERVAL
    const startSearchSlot = Math.floor(latestFinalizedSlot / SLOT_INTERVAL) * SLOT_INTERVAL;
    // Define the end of the search range based on FIND_SLOT_SEARCH_RANGE
    const endSearchSlot = Math.max(0, latestFinalizedSlot - FIND_SLOT_SEARCH_RANGE); // Ensure it doesn't go below 0

    logger.info(`Search range: slots ${endSearchSlot} to ${startSearchSlot}`);

    for (let slot = startSearchSlot; slot >= endSearchSlot; slot -= SLOT_INTERVAL) {
        if (slot <= 0) break; // Stop if we reach genesis or invalid slots

        try {
            // Check if a state root exists for this slot in the light client
            logger.debug(`findAvailableFinalisedSlot: Checking slot ${slot}...`); // DEBUG LOG
            const stateRoot = await helios.executionStateRoots(slot);
            logger.debug(`findAvailableFinalisedSlot: Slot ${slot} stateRoot: ${stateRoot}`); // DEBUG LOG

            if (stateRoot !== ethers.ZeroHash) {
                // If root exists, map the slot to an L1 execution block
                logger.debug(`findAvailableFinalisedSlot: Mapping slot ${slot} to EL block...`); // DEBUG LOG
                const blockRef = await slotToELBlock(L1_CONSENSUS_RPC_URL!, l1Provider, slot);
                logger.info(`Checking slot ${slot} (maps to block ${blockRef.number})...`);

                // Check if this L1 block is at or after the deposit block
                if (blockRef.number >= depositBlockNumber) {
                    logger.info(`✅ Found finalized slot ${slot} (block ${blockRef.number}) with state root ${stateRoot} for deposit block ${depositBlockNumber}`);
                    return { slot, stateRoot }; // Found a suitable slot
                } else {
                    logger.info(`Slot ${slot} (block ${blockRef.number}) is before target block ${depositBlockNumber}`);
                }
            } else {
                 logger.debug(`findAvailableFinalisedSlot: Slot ${slot} has no state root.`); // DEBUG LOG
            }
        } catch (err: any) {
            // Log error during slot mapping but continue searching other slots
            logger.warn(`Error mapping/checking slot ${slot}: ${err.message || String(err)}. Continuing search...`);
        }
    }

    // If the loop finishes without returning, no suitable slot was found
    logger.error(`findAvailableFinalisedSlot: Failed to find suitable slot for block ${depositBlockNumber} in range ${endSearchSlot}-${startSearchSlot}`); // ERROR LOG
    throw new Error(`No available finalized slot with state root found covering block ${depositBlockNumber} within search range (${endSearchSlot} to ${startSearchSlot})`);
}


/**
 * Main function to start the ETH->Citrea relayer process.
 */
export default async function startEthToCitreaRelayer(): Promise<void> {
    logger.info("⛓️ ETH->Citrea relayer starting...");

    let lastProcessedL1Block = await l1Provider.getBlockNumber() - L1_BLOCK_CONFIRMATIONS;
    logger.info(`Starting L1 scan from block number: ${lastProcessedL1Block}`);

    // Initialize processed deposits from BridgeCitrea state (best effort)
    try {
        const tempBridgeCitrea = new Contract(L2_BRIDGE_ADDRESS!, BridgeCitreaAbi, l2Provider);
        const currentL1Nonce = await bridgeEth.currentNonce();
        const checkPromises: Promise<void>[] = [];
        logger.info(`Checking initial processed status up to L1 nonce ${currentL1Nonce}...`);
        const startCheckNonce = Math.max(1, Number(currentL1Nonce) - 1000);
        for (let i = startCheckNonce; i <= Number(currentL1Nonce); i++) {
            checkPromises.push(
                (async () => {
                    try {
                        const isProcessed = await tempBridgeCitrea.isProcessed(i);
                        if (isProcessed) {
                            processedDeposits.add(i);
                        }
                    } catch (initCheckError: any) {
                         logger.warn(`Failed to check initial status for nonce ${i}: ${initCheckError.message}`);
                    }
                })()
            );
        }
        await Promise.all(checkPromises);
        logger.info(`Initialized. Found ${processedDeposits.size} already processed deposits (checked from nonce ${startCheckNonce}).`);
    } catch (error: any) {
        logger.error(`Error initializing processed deposits: ${error.message}. Continuing...`);
    }

    // Setup status update interval (uses consensus finality)
    setInterval(async () => {
        try {
            const pendingTxs = await TransactionModel.find({
                status: { $nin: [TransactionStatus.CONFIRMED, TransactionStatus.FAILED, TransactionStatus.EXPIRED] },
                fromChain: Chain.ETHEREUM,
                toChain: Chain.CITREA
            });

            for (const tx of pendingTxs) {
                if (!tx.txHash) continue;
                try {
                    const receipt = await l1Provider.getTransactionReceipt(tx.txHash);
                    if (!receipt || typeof receipt.blockNumber !== 'number') continue; // Check blockNumber type

                    const finalityStatus = await getBestFinalityStatus(receipt.blockNumber, tx, l1Provider);
                    publishStatusUpdate("finality", finalityStatus.phase, JSON.stringify({
                        txHash: tx.txHash,
                        depositBlock: receipt.blockNumber,
                        phase: finalityStatus.phase,
                        etaSeconds: finalityStatus.etaSeconds,
                        percentage: finalityStatus.pct
                    }));
                } catch (receiptError: any) {
                     logger.warn(`Could not get receipt or finality for tx ${tx.txHash}: ${receiptError.message}`);
                     // Optionally publish a 'checking' or 'unknown' status
                }
            }
        } catch (error: any) {
            logger.warn(`Error updating transaction finality status: ${error.message}`);
        }
    }, STATUS_UPDATE_INTERVAL_MS);

    // --- Main Relayer Loop ---
    setInterval(async () => {
        let bridgeCitreaInstance: Contract | null = null;
        let heliosInstance: Contract | null = null;
        let heliosAddr: string | null = null;

        try {
            // --- Get Fresh L2 Contract Instances ---
            try {
                 // Create a temporary instance just to get the light client address
                 const tempBridge = new Contract(L2_BRIDGE_ADDRESS!, BridgeCitreaAbi, l2Provider);
                 heliosAddr = await tempBridge.getLightClient();
                 if(!heliosAddr || heliosAddr === ethers.ZeroAddress){
                     logger.error("Failed to get valid SP1Helios address from BridgeCitrea contract. Retrying next interval...");
                     return; // Skip this interval
                 }
                 // Now create the instances we'll actually use
                 const freshContracts = getFreshL2Contracts(heliosAddr);
                 bridgeCitreaInstance = freshContracts.bridgeCitreaInstance;
                 heliosInstance = freshContracts.heliosInstance;
                 // logger.info("Refreshed L2 contract instances."); // Log less frequently if needed
            } catch(contractInitError: any) {
                 logger.error(`Failed to initialize L2 contracts: ${contractInitError.message}. Retrying next interval.`);
                 return; // Skip this interval if contracts can't be initialized
            }

            // --- Scan L1 Blocks for Events ---
            const head = await l1Provider.getBlockNumber();
            const fromBlock = lastProcessedL1Block + 1;
            const toBlock = head - L1_BLOCK_CONFIRMATIONS;

            if (fromBlock > toBlock) {
                lastProcessedL1Block = head; // Keep track of actual head even if not processing
                return; // Nothing to process yet
            }

            logger.info(`Scanning L1 blocks ${fromBlock} to ${toBlock} (head: ${head})`);

            // Fetch events in batches if needed, for now fetch all in range
            const ethEvents = await bridgeEth.queryFilter(
                bridgeEth.filters.DepositETH(), fromBlock, toBlock
            );
            const erc20Events = await bridgeEth.queryFilter(
                bridgeEth.filters.DepositERC20(), fromBlock, toBlock
            );

             const allEvents = [...ethEvents, ...erc20Events].sort((a, b) =>
                 a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex
             ) as EventLog[];

            if (allEvents.length > 0) {
                logger.info(`Found ${allEvents.length} new deposit events between blocks ${fromBlock} and ${toBlock}.`);
            }

            // --- Process Events Sequentially (or with limited concurrency) ---
            for (const event of allEvents) {
                 const log = bridgeEth.interface.parseLog({ topics: [...event.topics], data: event.data });
                 if (!log) continue;
                 const { nonce } = log.args as any;
                 const nonceNumber = Number(nonce);

                 // Skip checks - handled within handleDeposit now
                 if (processingDeposits.has(nonceNumber)) {
                     logger.info(`Nonce ${nonceNumber} is already being processed, skipping.`);
                     continue;
                 }

                 // Await each handler to process sequentially for simplicity
                 // Use a queue/limiter in production if needed
                 await handleDeposit(
                    event,
                    bridgeCitreaInstance, // Pass fresh instance
                    heliosInstance, // Pass fresh instance
                    log.name === 'DepositETH'
                 ).catch(err => {
                    logger.error(`Error processing deposit nonce ${nonceNumber}: ${err.message}`);
                    // Ensure processing lock is released even if handleDeposit throws unexpectedly
                    processingDeposits.delete(nonceNumber);
                });
            }

            lastProcessedL1Block = toBlock; // Update last processed block

        } catch (error: any) {
            logger.error(`Error in main relayer interval: ${error.message}`);
        }
    }, POLLING_INTERVAL_MS);
}


/**
 * Handles processing a single deposit event, including finality checks, proof generation, and submission.
 * @param event The deposit event log.
 * @param bridgeCitrea Fresh instance of the BridgeCitrea contract.
 * @param helios Fresh instance of the SP1Helios contract.
 * @param isEth Whether the deposit was for native ETH.
 */
async function handleDeposit(
    event: EventLog,
    bridgeCitrea: Contract,
    helios: Contract,
    isEth: boolean
): Promise<void> {
    const log = bridgeEth.interface.parseLog({ topics: [...event.topics], data: event.data });
    if (!log) return;

    const { nonce, amount, from, to, token: l1TokenAddress } = log.args as any;
    const nonceNumber = Number(nonce);
    const depositBlockNumber = event.blockNumber;
    const txHash = event.transactionHash;

    // --- Declare transaction variable in the function scope ---
    let transaction: ITransaction | null = null;

    // --- Pre-check Processing Status ---
    if (processedDeposits.has(nonceNumber)) {
        return; // Already done
    }
    if (processingDeposits.has(nonceNumber)) {
        logger.warn(`Deposit #${nonceNumber} processing already in progress (detected race condition?). Skipping.`);
        return; // Avoid race conditions
    }
    const currentFailureCount = failedAttempts.get(nonceNumber) || 0;
    if (currentFailureCount >= MAX_FAILED_ATTEMPTS) {
        logger.warn(`Deposit #${nonceNumber} skipped (max runtime retries [${currentFailureCount}] reached).`);
        return;
    }

    // --- Mark as Processing ---
    processingDeposits.add(nonceNumber);
    logger.info(`Processing deposit #${nonceNumber} (Tx: ${txHash}, Block: ${depositBlockNumber})`);

    try {
        // --- Check On-Chain Status ---
        const isAlreadyProcessed = await bridgeCitrea.isProcessed(nonce);
        if (isAlreadyProcessed) {
            logger.info(`Deposit #${nonceNumber} already processed on-chain.`);
            processedDeposits.add(nonceNumber); // Ensure local state matches
            failedAttempts.delete(nonceNumber); // Clear runtime failures
            transaction = await TransactionModel.findOne({ txHash: txHash });
            if (transaction && transaction.status !== TransactionStatus.CONFIRMED) {
                transaction.status = TransactionStatus.CONFIRMED;
                transaction.timestamps.confirmed = transaction.timestamps.confirmed || new Date();
                await transaction.save();
                publishTransactionUpdate(transaction);
            }
            processingDeposits.delete(nonceNumber); // Release lock
            return; // Exit successfully
        }

        // --- Find/Create DB Transaction ---
        transaction = await TransactionModel.findOne({ txHash: txHash });
        const blockTimestamp = await l1Provider.getBlock(depositBlockNumber).then(b => b?.timestamp ? b.timestamp * 1000 : Date.now());

        if (!transaction) {
            transaction = new TransactionModel({
                txHash: txHash, fromChain: Chain.ETHEREUM, toChain: Chain.CITREA,
                sender: from, recipient: to, token: isEth ? ethers.ZeroAddress : l1TokenAddress,
                amount: amount.toString(), status: TransactionStatus.PENDING, retries: 0,
                timestamps: { initiated: new Date(blockTimestamp) }
            });
            await transaction.save();
            publishTransactionUpdate(transaction);
             logger.info(`Created new DB entry for transaction ${txHash}`);
        } else if (transaction.status === TransactionStatus.FAILED && transaction.retries < MAX_FAILED_ATTEMPTS) {
            logger.info(`Retrying failed transaction ${txHash} (DB attempt ${transaction.retries + 1})`);
            transaction.status = TransactionStatus.PENDING;
            transaction.error = undefined;
            await transaction.save();
            publishTransactionUpdate(transaction);
        } else if (transaction.status !== TransactionStatus.PENDING) {
             logger.info(`Transaction ${txHash} has status ${transaction.status} in DB, skipping handleDeposit logic.`);
             processingDeposits.delete(nonceNumber); // Release lock
             return;
        }


        // --- Check L1 Finality (using consensus utils) ---
         const finalityStatus = await getBestFinalityStatus(depositBlockNumber, transaction, l1Provider);
         publishStatusUpdate("finality", finalityStatus.phase, JSON.stringify({ txHash, depositBlock: depositBlockNumber, phase: finalityStatus.phase, etaSeconds: finalityStatus.etaSeconds, percentage: finalityStatus.pct }));

        if (finalityStatus.phase !== "FINALIZED" && finalityStatus.phase !== "MINTED") {
            logger.info(`Deposit #${nonceNumber} block ${depositBlockNumber} not yet finalized (Status: ${finalityStatus.phase}). Waiting...`);
            processingDeposits.delete(nonceNumber); // Release lock, will retry next interval
            return;
        }
         logger.info(`Deposit #${nonceNumber} block ${depositBlockNumber} is finalized.`);


        // --- Read Head & Finality (with Retries for Stale Reads) ---
        let currentHead = 0;
        let minSlotFinality = 0;
        let readSuccess = false;
        for (let attempt = 1; attempt <= READ_HEAD_MAX_RETRIES; attempt++) {
            try {
                [currentHead, minSlotFinality] = await Promise.all([
                    helios.head().then(Number),
                    bridgeCitrea.minSlotFinality().then(Number)
                ]);
                 logger.info(`Read attempt ${attempt}: Head=${currentHead}, MinFinality=${minSlotFinality}`);

                // Enhanced staleness check using block timestamp
                let headBlockTimestamp = 0;
                try {
                    const headBlock = await slotToELBlock(L1_CONSENSUS_RPC_URL!, l1Provider, currentHead);
                    const blockData = await l1Provider.getBlock(headBlock.number);
                    headBlockTimestamp = (blockData?.timestamp ?? 0) * 1000; // Get timestamp in ms
                } catch (mapError: any) {
                     logger.warn(`Could not map head slot ${currentHead} to block for staleness check: ${mapError.message}`);
                     // Proceed without timestamp check if mapping fails, rely on other checks
                }

                const now = Date.now();
                const maxStaleTime = MAX_HEAD_STALENESS_MINUTES * 60 * 1000;

                if (headBlockTimestamp > 0 && (now - headBlockTimestamp > maxStaleTime) && attempt < READ_HEAD_MAX_RETRIES) {
                    logger.warn(`Read head ${currentHead} timestamp (${new Date(headBlockTimestamp).toISOString()}) is older than ${MAX_HEAD_STALENESS_MINUTES} mins. Retrying read after ${READ_HEAD_RETRY_DELAY_MS}ms...`);
                    await delay(READ_HEAD_RETRY_DELAY_MS);
                    continue;
                }

                // Additional check: Is the calculated latestFinalizedSlot reasonable?
                const latestFinalizedSlot = currentHead - minSlotFinality;
                if (latestFinalizedSlot <= 0 && attempt < READ_HEAD_MAX_RETRIES) {
                     logger.warn(`Calculated latestFinalizedSlot (${latestFinalizedSlot}) is invalid. Head or Finality might be wrong. Retrying read...`);
                     await delay(READ_HEAD_RETRY_DELAY_MS);
                     continue; // Retry reading
                }

                readSuccess = true; // If checks pass, assume read is good enough
                break; // Success
            } catch (readError: any) {
                logger.error(`Error reading head/finality (attempt ${attempt}): ${readError.message}`);
                if (attempt === READ_HEAD_MAX_RETRIES) {
                    failedAttempts.set(nonceNumber, (failedAttempts.get(nonceNumber) || 0) + 1);
                    transaction.status = TransactionStatus.FAILED;
                    transaction.error = `Failed to read L2 state after ${READ_HEAD_MAX_RETRIES} attempts: ${readError.message}`;
                    transaction.timestamps.failed = new Date();
                    transaction.retries = (transaction.retries || 0) + 1;
                    await transaction.save();
                    publishTransactionUpdate(transaction);
                    processingDeposits.delete(nonceNumber);
                    return;
                }
                await delay(READ_HEAD_RETRY_DELAY_MS);
            }
        }
        if (!readSuccess) {
             logger.error(`Logic error: Failed to read head/finality but didn't exit retry loop for nonce ${nonceNumber}.`);
             processingDeposits.delete(nonceNumber);
             return;
        }


        // --- Find Suitable Finalized Slot ---
        let slotInfo: { slot: number; stateRoot: string };
        try {
            logger.info(`Deposit #${nonceNumber}: Attempting to find finalized slot...`); // LOGGING
            transaction.status = TransactionStatus.PROOF_GENERATING;
            transaction.timestamps.proofStarted = new Date();
            await transaction.save();
            publishTransactionUpdate(transaction);

            slotInfo = await findAvailableFinalisedSlot(helios, depositBlockNumber, currentHead, minSlotFinality);
            logger.info(`Deposit #${nonceNumber}: Found suitable slot ${slotInfo.slot}`); // LOGGING

        } catch (findSlotError: any) {
            logger.error(`Deposit #${nonceNumber}: Could not find suitable finalized slot: ${findSlotError.message}`);
             failedAttempts.set(nonceNumber, (failedAttempts.get(nonceNumber) || 0) + 1);
             transaction.status = TransactionStatus.PENDING; // Revert status to allow retry next time
             transaction.error = `Slot finding failed: ${findSlotError.message}`;
             transaction.timestamps.proofStarted = undefined; // Clear timestamp
             await transaction.save();
             publishTransactionUpdate(transaction);
            processingDeposits.delete(nonceNumber); // Release lock
            return; // Exit handling for this deposit for now
        }

        const { slot: ethHeaderSlot, stateRoot } = slotInfo;

        // --- Generate MPT Proof ---
        logger.info(`Deposit #${nonceNumber}: Generating MPT proof using L1 state from slot ${ethHeaderSlot} (State Root: ${stateRoot.substring(0, 10)}...)`);
        let proofs: { accountProof: string; storageProof: string };
        try {
            const { number: stateBlockNumber } = await slotToELBlock(L1_CONSENSUS_RPC_URL!, l1Provider, ethHeaderSlot);
             logger.info(`Deposit #${nonceNumber}: Mapped proof slot ${ethHeaderSlot} to L1 execution block ${stateBlockNumber}`);

            const DEPOSITS_STORAGE_SLOT = BigInt(3); // Storage slot for 'deposits' mapping in BridgeEth
            const storageKey = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["uint256", "uint256"],
                    [nonce, DEPOSITS_STORAGE_SLOT]
                )
            );

            logger.info(`Deposit #${nonceNumber}: Calling getStorageProof for block ${stateBlockNumber}, key ${storageKey}...`); // LOGGING
            proofs = await getStorageProof(
                l1Provider,
                L1_BRIDGE_ADDRESS!, // BridgeEth contract address on L1
                stateBlockNumber,   // L1 block number corresponding to the chosen slot
                storageKey
            );
            logger.info(`Deposit #${nonceNumber}: MPT proof generated successfully.`); // LOGGING

            // Update DB
            transaction.status = TransactionStatus.PROOF_GENERATED;
            transaction.timestamps.proofGenerated = new Date();
            await transaction.save();
            publishTransactionUpdate(transaction);

        } catch (proofError: any) {
            logger.error(`Deposit #${nonceNumber}: Failed to generate MPT proof: ${proofError.message}`);
             failedAttempts.set(nonceNumber, (failedAttempts.get(nonceNumber) || 0) + 1);
             transaction.status = TransactionStatus.FAILED;
             transaction.error = `Proof generation failed: ${proofError.message}`;
             transaction.timestamps.failed = new Date();
             transaction.retries = (transaction.retries || 0) + 1; // Increment DB retry count
             await transaction.save();
             publishTransactionUpdate(transaction);
            processingDeposits.delete(nonceNumber); // Release lock
            return;
        }


        // --- Submit Finalization Transaction ---
        const depositStruct = {
            from,
            to,
            token: isEth ? ethers.ZeroAddress : l1TokenAddress,
            amount,
            nonce
        };

         logger.info(`Deposit #${nonceNumber}: Submitting finaliseDeposit tx to Citrea...`);
         logger.info(`   Nonce: ${nonceNumber}, Slot: ${ethHeaderSlot}, L1 Token: ${depositStruct.token}, Amount: ${amount.toString()}`);

        try {
            // Update DB status before sending tx
            transaction.status = TransactionStatus.SUBMITTED;
            transaction.timestamps.submitted = new Date();
            await transaction.save();
            publishTransactionUpdate(transaction);

            logger.info(`Deposit #${nonceNumber}: Sending finaliseDeposit transaction...`); // LOGGING
            const txResponse = await bridgeCitrea.finaliseDeposit(
                depositStruct,
                ethHeaderSlot,
                proofs.accountProof,
                proofs.storageProof,
                { gasLimit: SUBMIT_GAS_LIMIT } // Use configured gas limit
            );
            logger.info(`Deposit #${nonceNumber}: finaliseDeposit tx submitted: ${txResponse.hash}`); // LOGGING

            transaction.destinationTxHash = txResponse.hash; // Store L2 tx hash
            await transaction.save();
            publishTransactionUpdate(transaction); // Update UI with destination hash

            // --- Wait for Confirmation ---
            logger.info(`Deposit #${nonceNumber}: Waiting for confirmation (Tx: ${txResponse.hash})...`);
            const receipt = await txResponse.wait(1); // Wait for 1 confirmation on L2

            if (receipt && receipt.status === 1) {
                logger.info(`✅ Deposit #${nonceNumber} finalised successfully on Citrea (Tx: ${txResponse.hash})`);
                processedDeposits.add(nonceNumber); // Mark as fully processed locally
                failedAttempts.delete(nonceNumber); // Clear runtime failure count

                // Final DB update
                transaction.status = TransactionStatus.CONFIRMED;
                transaction.timestamps.confirmed = new Date();
                transaction.error = undefined; // Clear any previous errors
                await transaction.save();
                publishTransactionUpdate(transaction);

            } else {
                // L2 transaction reverted
                throw new Error(`Citrea tx reverted (Status: ${receipt?.status}) Hash: ${txResponse.hash}`);
            }

        } catch (submitError: any) {
            logger.error(`Deposit #${nonceNumber}: finaliseDeposit tx failed: ${submitError.message}`);
             failedAttempts.set(nonceNumber, (failedAttempts.get(nonceNumber) || 0) + 1); // Increment runtime retry count
             transaction.status = TransactionStatus.FAILED; // Mark as failed in DB
             transaction.error = `Submission/Confirmation failed: ${submitError.message}`;
             transaction.timestamps.failed = new Date();
             transaction.retries = (transaction.retries || 0) + 1; // Increment DB retry count
             await transaction.save();
             publishTransactionUpdate(transaction);
             // Lock remains released by finally block
        }

    } catch (error: any) {
        // Catch errors from steps before submission (e.g., DB access, finality check, head read)
        logger.error(`Unhandled error processing deposit #${nonceNumber} before submission: ${error.message}`);
         failedAttempts.set(nonceNumber, (failedAttempts.get(nonceNumber) || 0) + 1); // Increment runtime retry count

        // Update DB if transaction object exists
        if (transaction) {
            transaction.status = TransactionStatus.FAILED;
            transaction.error = `Pre-submission error: ${error.message}`;
            transaction.timestamps.failed = new Date();
            transaction.retries = (transaction.retries || 0) + 1; // Increment DB retry count
            await transaction.save().catch(dbErr => logger.error(`Failed to save error state to DB for ${txHash}: ${dbErr.message}`));
            publishTransactionUpdate(transaction);
        } else {
             logger.warn(`Could not update DB for failed tx ${txHash} because transaction object was null (error likely during fetch/create).`);
        }
    } finally {
        // ALWAYS remove from processing set, regardless of outcome
        logger.info(`Deposit #${nonceNumber}: Releasing processing lock in finally block. Existed: ${processingDeposits.has(nonceNumber)}`);
        processingDeposits.delete(nonceNumber);
        // logger.info(`Finished processing attempt for deposit #${nonceNumber}`); // Reduce log noise
    }
}


// --- Optional: Graceful Shutdown ---
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down ethToCitrea relayer...');
  // Add cleanup if needed, e.g., wait for pending handleDeposit calls?
  // For simplicity, we exit immediately now.
  process.exit(0);
});

// --- Start the Relayer ---
// Ensure this only runs when the script is executed directly
if (require.main === module) {
    startEthToCitreaRelayer().catch(error => {
        logger.error(`Relayer startup failed catastrophically: ${error.message}`);
        process.exit(1);
    });
}

// Export for potential use elsewhere if needed (though typically run as standalone)
// export { startEthToCitreaRelayer };
