// ECBridge/backend/src/relayer/mockRelayer.ts
// MOCK-ONLY VERSION with frontend transaction support

import {
    Contract,
    JsonRpcProvider,
    ethers,
    EventLog
} from "ethers";

// Import ABIs just for event parsing
import BridgeEthAbi from "../abi/BridgeEth.json";

// Import Models and PubSub
import { TransactionModel, TransactionStatus, Chain } from "../models";
import { publishTransactionUpdate, publishStatusUpdate } from "../index";
import logger from "../utils/logger";

// --- Configuration & Setup ---
const L1_RPC_URL = process.env.ETH_EXE_RPC_URL;
const L1_BRIDGE_ADDRESS = process.env.ETH_BRIDGE_ADDRESS;

// Relayer Behavior Settings
const POLLING_INTERVAL_MS = 10_000; // 10 seconds
const STATUS_UPDATE_INTERVAL_MS = 5_000; // 5 seconds
const L1_BLOCK_CONFIRMATIONS = 1; // How many blocks behind head to process
const PENDING_TX_CHECK_INTERVAL_MS = 15_000; // 15 seconds

// Validate required environment variables
if (!L1_RPC_URL || !L1_BRIDGE_ADDRESS) {
    logger.error("Missing required environment variables for mock relayer.");
    process.exit(1);
}

// --- Provider ---
const l1Provider = new JsonRpcProvider(L1_RPC_URL);

// L1 Bridge Contract (read-only, just for monitoring events)
const bridgeEth = new Contract(L1_BRIDGE_ADDRESS, BridgeEthAbi, l1Provider);

// --- Global State ---
const processedDeposits = new Set<string>(); // Track which txHashes we've "processed"
const processingTxs = new Set<string>(); // Track which txHashes are currently being processed

// Helper function for delays
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// Generate fake transaction hash
function generateFakeTxHash(): string {
    let hash = "0x";
    for (let i = 0; i < 64; i++) {
        hash += "0123456789abcdef"[Math.floor(Math.random() * 16)];
    }
    return hash;
}

/**
 * Process a transaction that was submitted through the frontend
 * @param transaction The transaction from the database
 */
async function processFrontendTransaction(transaction: any): Promise<void> {
    try {
        // Skip if already processed or currently processing
        if (processedDeposits.has(transaction.txHash) || processingTxs.has(transaction.txHash)) {
            return;
        }

        // Mark as processing
        processingTxs.add(transaction.txHash);
        
        // Check if transaction is confirmed on blockchain
        const receipt = await l1Provider.getTransactionReceipt(transaction.txHash);
        if (!receipt || receipt.status !== 1) {
            // Not confirmed yet or failed, skip for now
            processingTxs.delete(transaction.txHash);
            return;
        }

        logger.info(`🎬 MOCK: Processing frontend transaction ${transaction.txHash}`);

        // --- MOCK FLOW: Just update statuses with delays ---
        
        // Update status to PROOF_GENERATING
        logger.info(`🧪 MOCK: Generating proof for frontend transaction...`);
        transaction.status = TransactionStatus.PROOF_GENERATING;
        transaction.timestamps.proofStarted = new Date();
        await transaction.save();
        publishTransactionUpdate(transaction);
        
        // Short delay for UI experience
        await delay(1500);
        
        // Update status to PROOF_GENERATED
        logger.info(`📄 MOCK: Proof generated for frontend transaction!`);
        transaction.status = TransactionStatus.PROOF_GENERATED;
        transaction.timestamps.proofGenerated = new Date();
        await transaction.save();
        publishTransactionUpdate(transaction);
        
        // Short delay
        await delay(1000);
        
        // Update status to SUBMITTED
        logger.info(`📤 MOCK: Submitting frontend transaction...`);
        transaction.status = TransactionStatus.SUBMITTED;
        transaction.timestamps.submitted = new Date();
        
        // Generate fake destination tx hash
        const fakeTxHash = generateFakeTxHash();
        transaction.destinationTxHash = fakeTxHash;
        
        await transaction.save();
        publishTransactionUpdate(transaction);
        
        // Short delay
        await delay(2000);
        
        // Final status update to CONFIRMED
        logger.info(`✅ MOCK: Frontend transaction confirmed! Destination TX: ${fakeTxHash}`);
        transaction.status = TransactionStatus.CONFIRMED;
        transaction.timestamps.confirmed = new Date();
        await transaction.save();
        publishTransactionUpdate(transaction);
        publishStatusUpdate("finality", "MINTED", JSON.stringify({
            txHash: transaction.txHash,
            phase: "MINTED",
            etaSeconds: 0,
            percentage: 100
        }));
        // Remember this tx as processed
        processedDeposits.add(transaction.txHash);
        
    } catch (error: any) {
        logger.error(`Error processing frontend transaction ${transaction.txHash}: ${error.message}`);
    } finally {
        // Remove from processing
        processingTxs.delete(transaction.txHash);
    }
}

/**
 * Main function to start the ETH->Citrea mock relayer
 * This version doesn't interact with any contracts on Citrea side
 * It just monitors Ethereum events and updates the database.
 */
export default async function startMockRelayer(): Promise<void> {
    logger.info("🎭 Starting MOCK ETH->Citrea relayer (NO CONTRACT INTERACTIONS AT ALL)");
    logger.info("⚠️ This is a pure mock for demo purposes only!");

    let lastProcessedL1Block = await l1Provider.getBlockNumber() - L1_BLOCK_CONFIRMATIONS;
    logger.info(`Starting L1 scan from block number: ${lastProcessedL1Block}`);

    // Setup status update interval for all pending transactions
    setInterval(() => {
        try {
            TransactionModel.find({
                status: { $nin: [TransactionStatus.CONFIRMED, TransactionStatus.FAILED] },
                fromChain: Chain.ETHEREUM,
                toChain: Chain.CITREA
            }).then(pendingTxs => {
                pendingTxs.forEach(tx => {
                    if (tx.txHash) {
                        publishStatusUpdate("finality", "MOCK", JSON.stringify({
                            txHash: tx.txHash,
                            phase: "MOCK_BRIDGE",
                            etaSeconds: 5,
                            percentage: 95
                        }));
                    }
                });
            });
        } catch (error: any) {
            logger.warn(`Error in status update interval: ${error.message}`);
        }
    }, STATUS_UPDATE_INTERVAL_MS);

    // Setup interval to check pending transactions from frontend
    setInterval(async () => {
        try {
            // Find pending transactions that haven't been processed yet
            const pendingTxs = await TransactionModel.find({
                status: TransactionStatus.PENDING,
                fromChain: Chain.ETHEREUM,
                toChain: Chain.CITREA
            });

            logger.info(`Found ${pendingTxs.length} pending transactions to check`);

            // Process each pending transaction
            for (const tx of pendingTxs) {
                if (!processedDeposits.has(tx.txHash) && !processingTxs.has(tx.txHash)) {
                    processFrontendTransaction(tx);
                }
            }
        } catch (error: any) {
            logger.error(`Error checking pending transactions: ${error.message}`);
        }
    }, PENDING_TX_CHECK_INTERVAL_MS);

    // Main relayer loop for blockchain events
    setInterval(async () => {
        try {
            // Get the current L1 block number
            const head = await l1Provider.getBlockNumber();
            const fromBlock = lastProcessedL1Block + 1;
            const toBlock = head - L1_BLOCK_CONFIRMATIONS;

            if (fromBlock > toBlock) {
                // No new blocks to process
                lastProcessedL1Block = head - L1_BLOCK_CONFIRMATIONS;
                return;
            }

            logger.info(`🔍 Scanning L1 blocks ${fromBlock} to ${toBlock} (head: ${head})`);

            // Look for deposit events
            const ethEvents = await bridgeEth.queryFilter(
                bridgeEth.filters.DepositETH(), 
                fromBlock, 
                toBlock
            );
            
            const erc20Events = await bridgeEth.queryFilter(
                bridgeEth.filters.DepositERC20(), 
                fromBlock, 
                toBlock
            );

            const allEvents = [...ethEvents, ...erc20Events].sort((a, b) =>
                a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex
            ) as EventLog[];

            if (allEvents.length > 0) {
                logger.info(`✨ Found ${allEvents.length} new deposit events!`);
            }

            // Process each deposit event
            for (const event of allEvents) {
                const log = bridgeEth.interface.parseLog({ 
                    topics: [...event.topics], 
                    data: event.data 
                });
                
                if (!log) continue;
                
                const { nonce, amount, from, to, token: l1TokenAddress } = log.args as any;
                const nonceNumber = Number(nonce);
                const txHash = event.transactionHash;
                
                // Skip if already processed
                if (processedDeposits.has(txHash)) {
                    logger.info(`Transaction ${txHash} already processed, skipping.`);
                    continue;
                }
                
                logger.info(`🎬 MOCK: Processing deposit event for tx: ${txHash}`);
                
                // Find or create transaction in DB
                let transaction = await TransactionModel.findOne({ txHash });
                if (!transaction) {
                    transaction = new TransactionModel({
                        txHash,
                        fromChain: Chain.ETHEREUM,
                        toChain: Chain.CITREA,
                        sender: from,
                        recipient: to,
                        token: log.name === 'DepositETH' ? ethers.ZeroAddress : l1TokenAddress,
                        amount: amount.toString(),
                        status: TransactionStatus.PENDING,
                        timestamps: { initiated: new Date() }
                    });
                    await transaction.save();
                    logger.info(`Created new DB entry for transaction ${txHash}`);
                    publishTransactionUpdate(transaction);
                }
                
                // Skip if already being processed by the frontend transaction handler
                if (processingTxs.has(txHash)) {
                    logger.info(`Transaction ${txHash} is already being processed, skipping.`);
                    continue;
                }
                
                // --- MOCK FLOW: Just update statuses with delays ---
                
                // Mark as processing
                processingTxs.add(txHash);
                
                // Update status to PROOF_GENERATING
                logger.info(`🧪 MOCK: Generating proof for event transaction...`);
                transaction.status = TransactionStatus.PROOF_GENERATING;
                transaction.timestamps.proofStarted = new Date();
                await transaction.save();
                publishTransactionUpdate(transaction);
                
                // Short delay for UI experience
                await delay(1500);
                
                // Update status to PROOF_GENERATED
                logger.info(`📄 MOCK: Proof generated for event transaction!`);
                transaction.status = TransactionStatus.PROOF_GENERATED;
                transaction.timestamps.proofGenerated = new Date();
                await transaction.save();
                publishTransactionUpdate(transaction);
                
                // Short delay
                await delay(1000);
                
                // Update status to SUBMITTED
                logger.info(`📤 MOCK: Submitting event transaction...`);
                transaction.status = TransactionStatus.SUBMITTED;
                transaction.timestamps.submitted = new Date();
                
                // Generate fake destination tx hash
                const fakeTxHash = generateFakeTxHash();
                transaction.destinationTxHash = fakeTxHash;
                
                await transaction.save();
                publishTransactionUpdate(transaction);
                
                // Short delay
                await delay(2000);
                
                // Final status update to CONFIRMED
                logger.info(`✅ MOCK: Event transaction confirmed! Destination TX: ${fakeTxHash}`);
                transaction.status = TransactionStatus.CONFIRMED;
                transaction.timestamps.confirmed = new Date();
                await transaction.save();
                publishTransactionUpdate(transaction);
                
                // Remember this tx as processed
                processedDeposits.add(txHash);
                
                // Remove from processing
                processingTxs.delete(txHash);
            }
            
            // Update the last processed block
            lastProcessedL1Block = toBlock;
            
        } catch (error: any) {
            logger.error(`Error in main mock relayer loop: ${error.message}`);
        }
    }, POLLING_INTERVAL_MS);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down mock relayer...');
  process.exit(0);
});