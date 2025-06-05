// ECBridge/backend/src/relayer/index.ts
import { ethers } from 'ethers';
import { TransactionModel, TransactionStatus, Chain, ITransaction } from '../models';
import { EthereumConnector, CitreaConnector } from '../utils/connectors';
import { proofGenerator } from '../proof-generator';
import config from '../config';
import logger from '../utils/logger';
import { publishTransactionUpdate } from '../index';

export class RelayerService {
  private ethereumConnector: EthereumConnector;
  private citreaConnector: CitreaConnector;
  private isRunning: boolean = false;
  private ethereumLastBlock: number = 0;
  private citreaLastBlock: number = 0;
  
  constructor() {
    this.ethereumConnector = new EthereumConnector();
    this.citreaConnector = new CitreaConnector();
  }

  public async initialize(): Promise<void> {
    try {
      await this.ethereumConnector.connect();
      await this.citreaConnector.connect();
      
      if (!this.ethereumConnector.isConnected() || !this.ethereumConnector.getContract() || !config.ethereumBridgeAddress) {
        logger.warn('Relayer disabled: Ethereum connector not ready or bridge address missing');
        return;
      }
      if (!this.citreaConnector.isConnected() || !this.citreaConnector.getContract() || !config.citreaBridgeAddress) {
        logger.warn('Relayer disabled: Citrea connector not ready or bridge address missing');
        return;
      }
      
      if (config.ethereumPrivateKey) {
        this.ethereumConnector.setupSigner(config.ethereumPrivateKey);
      }
      
      if (config.citreaPrivateKey) {
        this.citreaConnector.setupSigner(config.citreaPrivateKey);
      }
      
      this.ethereumLastBlock = await this.ethereumConnector.getLatestBlockNumber();
      this.citreaLastBlock = await this.citreaConnector.getLatestBlockNumber();
      
      logger.info(`Relayer service initialized. Ethereum last block: ${this.ethereumLastBlock}, Citrea last block: ${this.citreaLastBlock}`);
    } catch (error) {
      logger.error(`Error initializing Relayer service: ${error}`);
      throw error;
    }
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Relayer service is already running');
      return;
    }
    
    this.isRunning = true;
    logger.info('Starting Relayer service');
    
    // Only monitor SP1Helios and track transactions
    this.monitorSP1Helios();
    this.processPendingTransactions();
    
    // Citrea to Ethereum monitoring (bonus feature)
    this.monitorCitreaEvents();
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Relayer service is not running');
      return;
    }
    
    this.isRunning = false;
    logger.info('Stopping Relayer service');
  }
  
  private async monitorSP1Helios(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    try {
      const sp1HeliosContract = this.citreaConnector.getSP1HeliosContract();
      
      if (!sp1HeliosContract) {
        logger.error('SP1Helios contract not initialized');
        setTimeout(() => this.monitorSP1Helios(), config.relayerPollingDelayMs);
        return;
      }
      
      const headInfo = await this.citreaConnector.getSP1HeliosHead();
      
      logger.info(`SP1Helios current head - Slot: ${headInfo.slot}, Execution State Root: ${headInfo.executionStateRoot}`);
      
      logger.info('SP1Helios monitoring started (event listeners disabled - using polling only)');
      
      // Poll for updates periodically
      setTimeout(() => this.monitorSP1Helios(), config.relayerPollingDelayMs);
    } catch (error) {
      logger.error(`Error monitoring SP1Helios: ${error}`);
      setTimeout(() => this.monitorSP1Helios(), config.relayerPollingDelayMs);
    }
  }
  
  private async monitorCitreaEvents(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    try {
      const citreaContract = this.citreaConnector.getContract();
      
      if (!citreaContract) {
        logger.error('Citrea bridge contract not initialized');
        setTimeout(() => this.monitorCitreaEvents(), config.relayerPollingDelayMs);
        return;
      }
      
      const currentBlock = await this.citreaConnector.getLatestBlockNumber();
      
      if (currentBlock > this.citreaLastBlock) {
        logger.info(`Scanning Citrea blocks ${this.citreaLastBlock + 1} to ${currentBlock}`);
        
        // Monitor for finalized deposits (for tracking purposes)
        const finalizedFilter = citreaContract.filters.Finalised();
        
        const finalizedEvents = await citreaContract.queryFilter(
          finalizedFilter,
          this.citreaLastBlock + 1,
          currentBlock
        );
        
        for (const event of finalizedEvents) {
          await this.processCitreaFinalizedEvent(event);
        }
        
        this.citreaLastBlock = currentBlock;
      }
    } catch (error) {
      logger.error(`Error monitoring Citrea events: ${error}`);
    }
    
    setTimeout(() => this.monitorCitreaEvents(), config.relayerPollingDelayMs);
  }

  private async processCitreaFinalizedEvent(event: ethers.EventLog | ethers.Log): Promise<void> {
    try {
      const iface = this.citreaConnector.getContract()?.interface;
      if (!iface) return;

      const parsedLog = iface.parseLog({
        topics: event.topics as string[],
        data: event.data
      });

      if (!parsedLog) return;

      const { token, to, amount, nonce } = parsedLog.args;
      
      logger.info(`Detected Finalised event: nonce ${nonce} - ${amount} of ${token} to ${to}`);
      
      // Find the transaction by nonce and update its status
      const transaction = await TransactionModel.findOne({
        fromChain: Chain.ETHEREUM,
        toChain: Chain.CITREA,
        // You might need to match by nonce here
      });
      
      if (transaction) {
        transaction.status = TransactionStatus.CONFIRMED;
        transaction.timestamps.confirmed = new Date();
        transaction.destinationTxHash = event.transactionHash;
        await transaction.save();
        
        publishTransactionUpdate(transaction);
        logger.info(`Transaction confirmed on Citrea: ${event.transactionHash}`);
      }
    } catch (error) {
      logger.error(`Error processing Finalised event: ${error}`);
    }
  }
  
  private async processPendingTransactions(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    
    try {
      // Monitor submitted transactions to check their confirmation status
      const submittedTransactions = await TransactionModel.find({
        status: TransactionStatus.SUBMITTED
      });
      
      for (const transaction of submittedTransactions) {
        await this.checkTransactionConfirmation(transaction);
      }
    } catch (error) {
      logger.error(`Error processing pending transactions: ${error}`);
    }
    
    setTimeout(() => this.processPendingTransactions(), config.relayerPollingDelayMs);
  }
  
  private async checkTransactionConfirmation(transaction: ITransaction): Promise<void> {
    try {
      if (!transaction.destinationTxHash) {
        logger.warn(`Transaction ${transaction._id} is missing destinationTxHash`);
        return;
      }
      
      const connector = transaction.toChain === Chain.ETHEREUM
        ? this.ethereumConnector
        : this.citreaConnector;
      
      const receipt = await connector.getTransactionReceipt(transaction.destinationTxHash);
      
      if (!receipt) {
        logger.info(`Transaction ${transaction.destinationTxHash} not yet confirmed`);
        return;
      }
      
      if (receipt.status === 0) {
        logger.error(`Transaction ${transaction.destinationTxHash} failed on-chain`);
        
        transaction.status = TransactionStatus.FAILED;
        transaction.error = 'Transaction failed on-chain';
        transaction.timestamps.failed = new Date();
        
        transaction.retries += 1;
        
        if (transaction.retries < config.maxRetries) {
          // Reset to allow retry
          transaction.status = TransactionStatus.PROOF_GENERATED;
        }
      } else {
        logger.info(`Transaction ${transaction.destinationTxHash} confirmed!`);
        
        transaction.status = TransactionStatus.CONFIRMED;
        transaction.timestamps.confirmed = new Date();
      }
      
      await transaction.save();
      
      publishTransactionUpdate(transaction);
    } catch (error) {
      logger.error(`Error checking transaction confirmation: ${error}`);
    }
  }
}

export const relayerService = new RelayerService();