// Fixed demo relayer that processes existing pending transactions
import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), override: true });

import {
    Contract,
    JsonRpcProvider,
    Wallet,
    ethers,
    EventLog
} from "ethers";

import BridgeEthAbi from "../abi/BridgeEth.json";
import BridgeCitreaAbi from "../abi/BridgeCitrea.json";

import { TransactionModel, TransactionStatus, Chain } from "../models";
import { publishTransactionUpdate, publishStatusUpdate } from "../index";
import { getBestFinalityStatus } from "../utils/consensus-utils";
import logger from "../utils/logger";

// Configuration
const L1_RPC_URL = process.env.ETH_EXE_RPC_URL;
const L2_RPC_URL = process.env.CITREA_RPC_URL;
const L1_BRIDGE_ADDRESS = process.env.ETH_BRIDGE_ADDRESS;
const L2_BRIDGE_ADDRESS = process.env.CITREA_BRIDGE_ADDRESS;
const L2_SIGNER_PRIVATE_KEY = process.env.CITREA_PRIVATE_KEY;

const POLLING_INTERVAL_MS = 15_000; // 15 seconds
const L1_BLOCK_CONFIRMATIONS = 1;

// Validate required environment variables
if (!L1_RPC_URL || !L2_RPC_URL || !L1_BRIDGE_ADDRESS || !L2_BRIDGE_ADDRESS || !L2_SIGNER_PRIVATE_KEY) {
    logger.error("Missing required environment variables for demo relayer.");
    process.exit(1);
}

// Providers & Wallet
const l1Provider = new JsonRpcProvider(L1_RPC_URL);
const l2Provider = new JsonRpcProvider(L2_RPC_URL);
const l2Wallet = new Wallet(L2_SIGNER_PRIVATE_KEY, l2Provider);

const bridgeEth = new Contract(L1_BRIDGE_ADDRESS, BridgeEthAbi, l1Provider);
const bridgeCitrea = new Contract(L2_BRIDGE_ADDRESS, BridgeCitreaAbi, l2Wallet);

// Global state
const processedDeposits = new Set<number>();
const processingDeposits = new Set<number>();

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Demo version: Process deposit after finality without complex proofs
 */
async function handleDepositDemo(
    event: EventLog,
    isEth: boolean
): Promise<void> {
    const log = bridgeEth.interface.parseLog({ topics: [...event.topics], data: event.data });
    if (!log) return;

    const { nonce, amount, from, to, token: l1TokenAddress } = log.args as any;
    const nonceNumber = Number(nonce);
    const depositBlockNumber = event.blockNumber;
    const txHash = event.transactionHash;

    // Pre-checks
    if (processedDeposits.has(nonceNumber)) {
        return;
    }
    if (processingDeposits.has(nonceNumber)) {
        logger.warn(`Deposit #${nonceNumber} already being processed`);
        return;
    }

    processingDeposits.add(nonceNumber);
    logger.info(`🎬 DEMO: Processing deposit #${nonceNumber} (Tx: ${txHash}, Block: ${depositBlockNumber})`);

    try {
        // Check if already processed on-chain
        const isAlreadyProcessed = await bridgeCitrea.isProcessed(nonce);
        if (isAlreadyProcessed) {
            logger.info(`Deposit #${nonceNumber} already processed on-chain.`);
            processedDeposits.add(nonceNumber);
            processingDeposits.delete(nonceNumber);
            
            // Update DB if needed
            const transaction = await TransactionModel.findOne({ txHash });
            if (transaction && transaction.status !== TransactionStatus.CONFIRMED) {
                transaction.status = TransactionStatus.CONFIRMED;
                transaction.timestamps.confirmed = transaction.timestamps.confirmed || new Date();
                await transaction.save();
                publishTransactionUpdate(transaction);
            }
            return;
        }

        // Find/Create DB Transaction
        let transaction = await TransactionModel.findOne({ txHash });
        const blockTimestamp = await l1Provider.getBlock(depositBlockNumber).then(b => b?.timestamp ? b.timestamp * 1000 : Date.now());

        if (!transaction) {
            transaction = new TransactionModel({
                txHash,
                fromChain: Chain.ETHEREUM,
                toChain: Chain.CITREA,
                sender: from,
                recipient: to,
                token: isEth ? '0x0000000000000000000000000000000000000001' : l1TokenAddress, // Demo canonical address for ETH
                amount: amount.toString(),
                status: TransactionStatus.PENDING,
                retries: 0,
                timestamps: { initiated: new Date(blockTimestamp) }
            });
            await transaction.save();
            publishTransactionUpdate(transaction);
            logger.info(`Created new DB entry for transaction ${txHash}`);
        }

        // Check L1 Finality
        const finalityStatus = await getBestFinalityStatus(depositBlockNumber, transaction, l1Provider);
        publishStatusUpdate("finality", finalityStatus.phase, JSON.stringify({
            txHash,
            depositBlock: depositBlockNumber,
            phase: finalityStatus.phase,
            etaSeconds: finalityStatus.etaSeconds,
            percentage: finalityStatus.pct
        }));

        if (finalityStatus.phase !== "FINALIZED" && finalityStatus.phase !== "MINTED") {
            logger.info(`🎬 DEMO: Deposit #${nonceNumber} block ${depositBlockNumber} not yet finalized (Status: ${finalityStatus.phase}). Waiting...`);
            processingDeposits.delete(nonceNumber);
            return;
        }

        logger.info(`🎬 DEMO: Deposit #${nonceNumber} block ${depositBlockNumber} is finalized. Processing without proofs...`);

        // Update status to PROOF_GENERATING (demo)
        transaction.status = TransactionStatus.PROOF_GENERATING;
        transaction.timestamps.proofStarted = new Date();
        await transaction.save();
        publishTransactionUpdate(transaction);

        // Simulate proof generation time
        await delay(2000);

        // Update status to PROOF_GENERATED (demo)
        transaction.status = TransactionStatus.PROOF_GENERATED;
        transaction.timestamps.proofGenerated = new Date();
        await transaction.save();
        publishTransactionUpdate(transaction);

        logger.info(`🎬 DEMO: Simulated proof generation for deposit #${nonceNumber}`);

        // Create deposit struct - use demo canonical address for ETH
        const depositStruct = {
            from,
            to,
            token: isEth ? '0x0000000000000000000000000000000000000001' : l1TokenAddress, // Demo canonical address for ETH
            amount,
            nonce
        };

        // Update status to SUBMITTED
        transaction.status = TransactionStatus.SUBMITTED;
        transaction.timestamps.submitted = new Date();
        await transaction.save();
        publishTransactionUpdate(transaction);

        logger.info(`🎬 DEMO: Calling finaliseDepositDemo for deposit #${nonceNumber}...`);

        // Call a demo version that skips verification
        try {
            const txResponse = await bridgeCitrea.finaliseDepositDemo(
                depositStruct,
                { gasLimit: 1500000 }
            );
            
            logger.info(`🎬 DEMO: finaliseDepositDemo tx submitted: ${txResponse.hash}`);

            transaction.destinationTxHash = txResponse.hash;
            await transaction.save();
            publishTransactionUpdate(transaction);

            // Wait for confirmation
            const receipt = await txResponse.wait();
            logger.info(`🎬 DEMO: finaliseDepositDemo confirmed in block ${receipt!.blockNumber}`);

            // Final status update
            transaction.status = TransactionStatus.CONFIRMED;
            transaction.timestamps.confirmed = new Date();
            await transaction.save();
            publishTransactionUpdate(transaction);

            publishStatusUpdate("finality", "MINTED", JSON.stringify({
                txHash,
                phase: "MINTED",
                etaSeconds: 0,
                percentage: 100
            }));

            processedDeposits.add(nonceNumber);
            logger.info(`🎉 DEMO: Deposit #${nonceNumber} successfully processed!`);

        } catch (contractError: any) {
            logger.error(`🎬 DEMO: Contract call failed for deposit #${nonceNumber}: ${contractError.message}`);
            
            transaction.status = TransactionStatus.FAILED;
            transaction.error = `Demo processing failed: ${contractError.message}`;
            transaction.timestamps.failed = new Date();
            transaction.retries = (transaction.retries || 0) + 1;
            await transaction.save();
            publishTransactionUpdate(transaction);
        }

    } catch (error: any) {
        logger.error(`🎬 DEMO: Error processing deposit #${nonceNumber}: ${error.message}`);
        
        const transaction = await TransactionModel.findOne({ txHash });
        if (transaction) {
            transaction.status = TransactionStatus.FAILED;
            transaction.error = `Demo error: ${error.message}`;
            transaction.timestamps.failed = new Date();
            transaction.retries = (transaction.retries || 0) + 1;
            await transaction.save();
            publishTransactionUpdate(transaction);
        }
    } finally {
        processingDeposits.delete(nonceNumber);
    }
}

/**
 * Process existing pending transactions from database
 */
async function processPendingTransactions(): Promise<void> {
    logger.info("🎬 DEMO: Checking for existing pending transactions...");
    
    try {
        // Find all pending transactions
        const pendingTxs = await TransactionModel.find({
            status: TransactionStatus.PENDING,
            fromChain: Chain.ETHEREUM,
            toChain: Chain.CITREA
        });
        
        logger.info(`🎬 DEMO: Found ${pendingTxs.length} pending transactions`);
        
        for (const tx of pendingTxs) {
            if (!tx.txHash) continue;
            
            logger.info(`🎬 DEMO: Checking pending transaction ${tx.txHash}`);
            
            // Get transaction receipt
            const receipt = await l1Provider.getTransactionReceipt(tx.txHash);
            if (!receipt) {
                logger.warn(`🎬 DEMO: Transaction ${tx.txHash} not found on chain`);
                continue;
            }
            
            // Parse the event
            for (const log of receipt.logs) {
                try {
                    if (log.address.toLowerCase() !== L1_BRIDGE_ADDRESS!.toLowerCase()) continue;
                    
                    const parsed = bridgeEth.interface.parseLog({
                        topics: [...log.topics],
                        data: log.data
                    });
                    
                    if (parsed && (parsed.name === 'DepositETH' || parsed.name === 'DepositERC20')) {
                        logger.info(`🎬 DEMO: Processing existing pending deposit from transaction ${tx.txHash}`);
                        
                        // Create EventLog object
                        const eventLog: EventLog = {
                            ...log,
                            blockNumber: receipt.blockNumber,
                            blockHash: receipt.blockHash,
                            transactionHash: receipt.hash,
                            transactionIndex: receipt.index,
                            removed: false,
                            index: log.index,
                            address: log.address,
                            topics: log.topics,
                            data: log.data
                        } as EventLog;
                        
                        await handleDepositDemo(eventLog, parsed.name === 'DepositETH').catch(err => {
                            logger.error(`🎬 DEMO: Error processing pending deposit: ${err.message}`);
                        });
                        
                        break; // Only process first matching event
                    }
                } catch (e) {
                    // Not a bridge event
                }
            }
        }
    } catch (error: any) {
        logger.error(`🎬 DEMO: Error processing pending transactions: ${error.message}`);
    }
}

/**
 * Main demo relayer function
 */
export default async function startDemoRealRelayer(): Promise<void> {
    logger.info("🎬 Starting DEMO REAL ETH->Citrea relayer");
    logger.info("🎬 This version waits for finality then processes without complex proofs");

    // Process existing pending transactions first
    await processPendingTransactions();

    let lastProcessedL1Block = await l1Provider.getBlockNumber() - L1_BLOCK_CONFIRMATIONS;
    logger.info(`🎬 DEMO: Starting L1 scan from block number: ${lastProcessedL1Block}`);

    // Main relayer loop
    setInterval(async () => {
        try {
            const head = await l1Provider.getBlockNumber();
            const fromBlock = lastProcessedL1Block + 1;
            const toBlock = head - L1_BLOCK_CONFIRMATIONS;

            if (fromBlock > toBlock) {
                lastProcessedL1Block = head - L1_BLOCK_CONFIRMATIONS;
                return;
            }

            logger.info(`🎬 DEMO: Scanning L1 blocks ${fromBlock} to ${toBlock} (head: ${head})`);

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
                logger.info(`🎬 DEMO: Found ${allEvents.length} new deposit events!`);
            }

            // Process each deposit event
            for (const event of allEvents) {
                const log = bridgeEth.interface.parseLog({
                    topics: [...event.topics],
                    data: event.data
                });

                if (!log) continue;

                const { nonce } = log.args as any;
                const nonceNumber = Number(nonce);

                if (processingDeposits.has(nonceNumber)) {
                    logger.info(`🎬 DEMO: Nonce ${nonceNumber} already being processed, skipping.`);
                    continue;
                }

                await handleDepositDemo(event, log.name === 'DepositETH').catch(err => {
                    logger.error(`🎬 DEMO: Error processing deposit nonce ${nonceNumber}: ${err.message}`);
                    processingDeposits.delete(nonceNumber);
                });
            }

            lastProcessedL1Block = toBlock;

        } catch (error: any) {
            logger.error(`🎬 DEMO: Error in main relayer loop: ${error.message}`);
        }
    }, POLLING_INTERVAL_MS);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('🎬 DEMO: SIGINT received, shutting down demo relayer...');
    process.exit(0);
});