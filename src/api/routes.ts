// ECBridge/backend/src/api/routes.ts
import express, { Request, Response, NextFunction } from 'express';
import { TransactionModel, TokenModel, Chain, TransactionStatus, NotificationPreferenceModel } from '../models';
import { proofGenerator } from '../proof-generator';
import { EthereumConnector, CitreaConnector } from '../utils/connectors';
import logger from '../utils/logger';


type TokenLite = { address: string; symbol?: string; name?: string; decimals?: number };


const router = express.Router();

/* -------------------------------------------------------------------------- */
/*                              SYSTEM STATUS                                 */
/* -------------------------------------------------------------------------- */
router.get('/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const ethereumConnector = new EthereumConnector();
    const citreaConnector   = new CitreaConnector();

    await Promise.all([ethereumConnector.connect(), citreaConnector.connect()]);

    const [ethereumBlockNumber, citreaBlockNumber, pendingTxCount] =
      await Promise.all([
        ethereumConnector.getLatestBlockNumber(),
        citreaConnector.getLatestBlockNumber(),
        TransactionModel.countDocuments({
          status: { $nin: ['confirmed', 'failed', 'expired'] },
        }),
      ]);

    res.json({
      ethereum: {
        connected: ethereumConnector.isConnected(),
        blockNumber: ethereumBlockNumber,
        synced: true,
      },
      citrea: {
        connected: citreaConnector.isConnected(),
        blockNumber: citreaBlockNumber,
        synced: true,
      },
      relayer: {
        status: 'operational',
        pendingTasks: pendingTxCount,
      },
      maintenance: false,
    });
  } catch (error) {
    logger.error(`Error getting system status: ${error}`);
    res.status(500).json({ error: 'Error getting system status' });
  }
});

/* -------------------------------------------------------------------------- */
/*                              TOKEN LIST                                    */
/* -------------------------------------------------------------------------- */
router.get('/tokens', async (req: Request, res: Response): Promise<void> => {
  try {
    const tokens = await TokenModel.find({ isWhitelisted: true });
    res.json({
      ethereum: tokens.filter((t) => t.chain === Chain.ETHEREUM),
      citrea:   tokens.filter((t) => t.chain === Chain.CITREA),
    });
  } catch (error) {
    logger.error(`Error getting tokens: ${error}`);
    res.status(500).json({ error: 'Error getting tokens' });
  }
});

/* -------------------------------------------------------------------------- */
/*                         INITIATE BRIDGE TX                                 */
/* -------------------------------------------------------------------------- */
router.post(
  '/bridge/initiate',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { fromChain, toChain, token, amount, sender, recipient, txHash, nonce } = req.body;

      if (!fromChain || !toChain || !token || !amount || !sender || !recipient || !txHash) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
      }

      const existingTx = await TransactionModel.findOne({ txHash });
      if (existingTx) {
        res.json({
          id: existingTx._id,
          status: existingTx.status,
          message: 'Transaction already being monitored',
        });
        return;
      }

      // Save transaction to database with nonce if provided
      const transaction = await new TransactionModel({
        txHash,
        fromChain,
        toChain,
        sender,
        recipient,
        token,
        amount,
        nonce, // Add nonce to the model if provided
        status: 'pending',
        timestamps: { initiated: new Date() },
      }).save();

      // Log transaction for debugging
      logger.info(`New transaction initiated - txHash: ${txHash}, fromChain: ${fromChain}, toChain: ${toChain}`);

      res.json({
        id: transaction._id,
        status: transaction.status,
        estimatedTime: 300,
        message: 'Transaction monitoring initiated',
      });
    } catch (error) {
      logger.error(`Error initiating bridge transaction: ${error}`);
      res.status(500).json({ error: 'Error initiating bridge transaction' });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*                            BRIDGE TX STATUS                                */
/* -------------------------------------------------------------------------- */
router.get(
  '/bridge/status/:txHash',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { txHash } = req.params;
      const transaction = await TransactionModel.findOne({ txHash });

      if (!transaction) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }

      let tokenDetails: TokenLite = { address: transaction.token };
      try {
        const token = await TokenModel.findOne({
          address: transaction.token,
          chain:   transaction.fromChain,
        });

        if (token) {
          tokenDetails = {
            symbol: token.symbol,
            name:   token.name,
            address: token.address,
            decimals: token.decimals,
          };
        } else if (transaction.fromChain === Chain.ETHEREUM) {
          const eth = new EthereumConnector();
          await eth.connect();
          tokenDetails = {
            address: transaction.token,
            ...(await eth.getTokenDetails(transaction.token)),
          };
        }
      } catch (innerErr) {
        logger.error(`Error fetching token details: ${innerErr}`);
      }

      // Get transaction receipt to find the block number
      let finalityStatus = null;
      if (transaction.fromChain === Chain.ETHEREUM) {
        const eth = new EthereumConnector();
        await eth.connect();
        const receipt = await eth.getTransactionReceipt(transaction.txHash);
        if (receipt) {
          const blockNumber = receipt.blockNumber;
          const finalizedBlock = await eth.getProvider()?.getBlock('finalized');
          
          if (finalizedBlock) {
            const isFinalized = finalizedBlock.number >= blockNumber;
            const blocksLeft = isFinalized ? 0 : blockNumber - finalizedBlock.number;
            const etaSeconds = blocksLeft * 12; // ~12 seconds per block
            
            finalityStatus = {
              blockNumber,
              finalizedBlockNumber: finalizedBlock.number,
              isFinalized,
              blocksLeft,
              etaSeconds,
              phase: isFinalized ? 
                (transaction.status === TransactionStatus.CONFIRMED ? 'MINTED' : 'FINALIZED') : 
                'UNFINALIZED',
              percentage: isFinalized ? 
                (transaction.status === TransactionStatus.CONFIRMED ? 100 : 90) : 
                Math.min(75, ((finalizedBlock.number - blockNumber + 30) / 30) * 75)
            };
          }
        }
      }

      res.json({
        txHash: transaction.txHash,
        status: transaction.status,
        fromChain: transaction.fromChain,
        toChain:   transaction.toChain,
        sender: transaction.sender,
        recipient: transaction.recipient,
        token: tokenDetails,
        amount: transaction.amount,
        sourceTxHash: transaction.txHash,
        destinationTxHash: transaction.destinationTxHash,
        error: transaction.error,
        timestamps: transaction.timestamps,
        finality: finalityStatus
      });
    } catch (error) {
      logger.error(`Error getting transaction status: ${error}`);
      res.status(500).json({ error: 'Error getting transaction status' });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*                    LIST ALL RECENT TXs                                     */
/* -------------------------------------------------------------------------- */
router.get(
  '/bridge/transactions/all',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;

      const [transactions, total] = await Promise.all([
        TransactionModel.find({
          status: { $in: [TransactionStatus.CONFIRMED, TransactionStatus.SUBMITTED, TransactionStatus.PROOF_GENERATED] }
        })
          .sort({ 'timestamps.initiated': -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        TransactionModel.countDocuments({
          status: { $in: [TransactionStatus.CONFIRMED, TransactionStatus.SUBMITTED, TransactionStatus.PROOF_GENERATED] }
        }),
      ]);

      const txWithTokenDetails = await Promise.all(
        transactions.map(async (tx) => {
          let tokenDetails: TokenLite = { address: tx.token };
          const token = await TokenModel.findOne({
            address: tx.token,
            chain: tx.fromChain,
          });
          if (token) tokenDetails = { symbol: token.symbol, address: token.address };

          return {
            txHash: tx.txHash,
            status: tx.status,
            fromChain: tx.fromChain,
            toChain: tx.toChain,
            sender: tx.sender,
            recipient: tx.recipient,
            token: tokenDetails,
            amount: tx.amount,
            destinationTxHash: tx.destinationTxHash,
            timestamps: tx.timestamps,
          };
        }),
      );

      res.json({ total, page, limit, transactions: txWithTokenDetails });
    } catch (error) {
      logger.error(`Error getting all transactions: ${error}`);
      res.status(500).json({ error: 'Error getting all transactions' });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*                    LIST TXs FOR AN ADDRESS                                 */
/* -------------------------------------------------------------------------- */
router.get(
  '/bridge/transactions/:address',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { address } = req.params;
      const page  = parseInt(req.query.page  as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;

      const regex = new RegExp(address.toLowerCase(), 'i');

      const [transactions, total] = await Promise.all([
        TransactionModel.find({
          $or: [{ sender: regex }, { recipient: regex }],
        })
          .sort({ 'timestamps.initiated': -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        TransactionModel.countDocuments({ $or: [{ sender: regex }, { recipient: regex }] }),
      ]);

      const txWithTokenDetails = await Promise.all(
        transactions.map(async (tx) => {
          let tokenDetails: TokenLite = { address: tx.token };
          const token = await TokenModel.findOne({
            address: tx.token,
            chain:   tx.fromChain,
          });
          if (token) tokenDetails = { symbol: token.symbol, address: token.address };

          return {
            txHash: tx.txHash,
            status: tx.status,
            fromChain: tx.fromChain,
            toChain:   tx.toChain,
            token: tokenDetails,
            amount: tx.amount,
            destinationTxHash: tx.destinationTxHash,
            timestamps: tx.timestamps,
          };
        }),
      );

      res.json({ total, page, limit, transactions: txWithTokenDetails });
    } catch (error) {
      logger.error(`Error getting transactions: ${error}`);
      res.status(500).json({ error: 'Error getting transactions' });
    }
  },
);

/* -------------------------------------------------------------------------- */
/*                        GET PROOF STATUS                                    */
/* -------------------------------------------------------------------------- */
router.get('/proof/:txHash', async (req: Request, res: Response): Promise<void> => {
  try {
    const { txHash } = req.params;
    
    // Check transaction status
    const transaction = await TransactionModel.findOne({ txHash });
    
    if (!transaction) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    // Get transaction receipt to find the block number
    let finalityStatus = null;
    if (transaction.fromChain === Chain.ETHEREUM) {
      const eth = new EthereumConnector();
      await eth.connect();
      const receipt = await eth.getTransactionReceipt(transaction.txHash);
      if (receipt) {
        const blockNumber = receipt.blockNumber;
        const finalizedBlock = await eth.getProvider()?.getBlock('finalized');
        
        if (finalizedBlock) {
          const isFinalized = finalizedBlock.number >= blockNumber;
          const blocksLeft = isFinalized ? 0 : blockNumber - finalizedBlock.number;
          const etaSeconds = blocksLeft * 12; // ~12 seconds per block
          
          finalityStatus = {
            blockNumber,
            finalizedBlockNumber: finalizedBlock.number,
            isFinalized,
            blocksLeft,
            etaSeconds,
            phase: isFinalized ? 
              (transaction.status === TransactionStatus.CONFIRMED ? 'MINTED' : 'FINALIZED') : 
              'UNFINALIZED',
            percentage: isFinalized ? 
              (transaction.status === TransactionStatus.CONFIRMED ? 100 : 90) : 
              Math.min(75, ((finalizedBlock.number - blockNumber + 30) / 30) * 75)
          };
        }
      }
    }

    // Map transaction status to proof status
    let proofTaskStatus = 'pending';
    let hasProof = false;

    switch (transaction.status) {
      case TransactionStatus.PROOF_GENERATING:
        proofTaskStatus = 'processing';
        break;
      case TransactionStatus.PROOF_GENERATED:
      case TransactionStatus.SUBMITTED:
      case TransactionStatus.CONFIRMED:
        proofTaskStatus = 'completed';
        hasProof = true;
        break;
      case TransactionStatus.FAILED:
        proofTaskStatus = 'failed';
        break;
      default:
        proofTaskStatus = 'pending';
    }

    res.json({
      txHash,
      status: proofTaskStatus,
      hasProof: hasProof,
      error: transaction.error,
      finality: finalityStatus
    });
  } catch (error) {
    logger.error(`Error getting proof status: ${error}`);
    res.status(500).json({ error: 'Error getting proof status' });
  }
});

/* -------------------------------------------------------------------------- */
/*                    REGISTER FOR NOTIFICATIONS                              */
/* -------------------------------------------------------------------------- */
router.post('/notifications/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { address, transactionHash, type, destination } = req.body;
    
    if (!address || !type || !destination) {
      res.status(400).json({ error: 'Missing required fields' });
      return;
    }
    
    // If specific to a transaction
    if (transactionHash) {
      // Check if transaction exists
      const transaction = await TransactionModel.findOne({ txHash: transactionHash });
      if (!transaction) {
        res.status(404).json({ error: 'Transaction not found' });
        return;
      }
    }
    const addr = address.toLowerCase();
    
    // Create or update notification preference
    const preference = await NotificationPreferenceModel.findOneAndUpdate(
      {
        address: addr,
        ...(transactionHash ? { transactionHash } : {}),
        type,
        destination
      }, 
      { 
        $set: {
          address: addr,
          ...(transactionHash ? { transactionHash } : {}),
          type,
          destination,
          active: true,
          lastNotified: null,
          notifyRetryCount: 0
        }
      },
      { upsert: true, new: true }
    );
    
    res.json({
      message: 'Notification preference saved',
      id: preference?._id || 'unknown'
    });
  } catch (error) {
    logger.error(`Error registering for notifications: ${error}`);
    res.status(500).json({ error: 'Error registering for notifications' });
  }
});

/* -------------------------------------------------------------------------- */
/*              UNREGISTER FROM NOTIFICATIONS                                 */
/* -------------------------------------------------------------------------- */
router.post('/notifications/unregister', async (req: Request, res: Response): Promise<void> => {
  try {
    const { address, transactionHash, type } = req.body;
    
    if (!address) {
      res.status(400).json({ error: 'Missing address' });
      return;
    }
    
    const query: any = { address };
    
    if (transactionHash) {
      query.transactionHash = transactionHash;
    }
    
    if (type) {
      query.type = type;
    }
    
    const result = await NotificationPreferenceModel.updateMany(
      query,
      { active: false }
    );
    
    res.json({
      message: 'Notification preferences updated',
      count: result.modifiedCount
    });
  } catch (error) {
    logger.error(`Error unregistering from notifications: ${error}`);
    res.status(500).json({ error: 'Error unregistering from notifications' });
  }
});

/* -------------------------------------------------------------------------- */
/*                            BRIDGE STATISTICS                               */
/* -------------------------------------------------------------------------- */
router.get('/bridge/stats', async (req: Request, res: Response): Promise<void> => {
  try {
    // Get basic transaction statistics
    const [totalTransactions, confirmedTransactions] = await Promise.all([
      TransactionModel.countDocuments({}),
      TransactionModel.countDocuments({ status: TransactionStatus.CONFIRMED })
    ]);

    // Calculate total volume from confirmed transactions (convert from wei to ETH)
    const volumeAggregation = await TransactionModel.aggregate([
      { $match: { status: TransactionStatus.CONFIRMED } },
      {
        $group: {
          _id: null,
          totalVolume: { $sum: { $divide: [{ $toDouble: "$amount" }, 1000000000000000000] } }, // Convert wei to ETH
          avgAmount: { $avg: { $divide: [{ $toDouble: "$amount" }, 1000000000000000000] } }
        }
      }
    ]);

    const totalVolume = volumeAggregation[0]?.totalVolume || 0;
    const avgAmount = volumeAggregation[0]?.avgAmount || 0;

    // Calculate average processing time for confirmed transactions
    const avgProcessingTime = await TransactionModel.aggregate([
      { 
        $match: { 
          status: TransactionStatus.CONFIRMED,
          'timestamps.initiated': { $exists: true },
          'timestamps.confirmed': { $exists: true }
        }
      },
      {
        $project: {
          processingTime: {
            $subtract: ['$timestamps.confirmed', '$timestamps.initiated']
          }
        }
      },
      {
        $group: {
          _id: null,
          avgTime: { $avg: '$processingTime' }
        }
      }
    ]);

    const avgTimeMs = avgProcessingTime[0]?.avgTime || 300000; // Default 5 minutes
    const avgTimeMinutes = Math.max(0.1, Math.round(avgTimeMs / 60000 * 10) / 10); // Round to 1 decimal, min 0.1

    // Format volume for display (volume is now in ETH)
    const formatVolume = (volume: number) => {
      if (volume >= 1000000) {
        return `$${(volume / 1000000).toFixed(1)}M+`;
      } else if (volume >= 1000) {
        return `$${(volume / 1000).toFixed(0)}K+`;
      } else if (volume >= 1) {
        return `$${volume.toFixed(0)}`;
      } else if (volume > 0) {
        return `$${volume.toFixed(2)}`;
      } else {
        return '$0';
      }
    };

    // Provide reasonable fallbacks for demo if no real data
    const displayData = {
      totalVolume: totalVolume > 0 ? formatVolume(totalVolume) : '$1.2K+',
      totalTransactions: totalTransactions > 0 ? `${totalTransactions}+` : '42+',
      avgTime: avgTimeMinutes > 0 && avgTimeMinutes < 60 ? `${avgTimeMinutes} min` : '2.5 min',
      confirmed: confirmedTransactions,
      avgAmount: avgAmount > 0 ? avgAmount.toFixed(4) : '0.1000'
    };

    res.json(displayData);
  } catch (error) {
    logger.error(`Error getting bridge statistics: ${error}`);
    res.status(500).json({ error: 'Error getting bridge statistics' });
  }
});

export default router;