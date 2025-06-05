// Debug script to check transaction status and finality
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import mongoose from 'mongoose';
import { JsonRpcProvider } from 'ethers';
import { TransactionModel } from '../src/models';
import { getBestFinalityStatus } from '../src/utils/consensus-utils';

async function debugTransaction(txHash?: string) {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ethcitrea');
    console.log('Connected to MongoDB');

    // Find transaction(s)
    const query = txHash ? { txHash } : { status: 'PENDING' };
    const transactions = await TransactionModel.find(query).sort({ createdAt: -1 }).limit(5);
    
    if (transactions.length === 0) {
      console.log('No transactions found');
      return;
    }

    // Setup provider
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const currentBlock = await l1Provider.getBlockNumber();
    console.log(`Current L1 block: ${currentBlock}`);

    // Check each transaction
    for (const tx of transactions) {
      console.log('\n' + '='.repeat(80));
      console.log(`Transaction: ${tx.txHash}`);
      console.log(`Status: ${tx.status}`);
      console.log(`Created: ${(tx as any).createdAt || 'N/A'}`);
      console.log(`Retries: ${tx.retries || 0}`);
      
      if (tx.error) {
        console.log(`Error: ${tx.error}`);
      }

      // Get transaction receipt
      const receipt = await l1Provider.getTransactionReceipt(tx.txHash);
      if (!receipt) {
        console.log('❌ Transaction not found on chain!');
        continue;
      }

      console.log(`Block: ${receipt.blockNumber}`);
      console.log(`Confirmations: ${currentBlock - receipt.blockNumber}`);
      
      // Check finality status
      console.log('\nChecking finality...');
      try {
        const finalityStatus = await getBestFinalityStatus(
          receipt.blockNumber,
          tx,
          l1Provider
        );
        console.log(`Finality Status: ${finalityStatus.phase}`);
        console.log(`ETA: ${finalityStatus.etaSeconds}s`);
        console.log(`Progress: ${finalityStatus.pct}%`);
      } catch (error: any) {
        console.log(`❌ Error checking finality: ${error.message}`);
      }

      // Check timestamps
      console.log('\nTimestamps:');
      if (tx.timestamps.initiated) console.log(`  Initiated: ${tx.timestamps.initiated}`);
      if (tx.timestamps.proofStarted) console.log(`  Proof Started: ${tx.timestamps.proofStarted}`);
      if (tx.timestamps.proofGenerated) console.log(`  Proof Generated: ${tx.timestamps.proofGenerated}`);
      if (tx.timestamps.submitted) console.log(`  Submitted: ${tx.timestamps.submitted}`);
      if (tx.timestamps.confirmed) console.log(`  Confirmed: ${tx.timestamps.confirmed}`);
      if (tx.timestamps.failed) console.log(`  Failed: ${tx.timestamps.failed}`);
    }

  } catch (error: any) {
    console.error('Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

// Run with optional transaction hash argument
const txHash = process.argv[2];
debugTransaction(txHash).catch(console.error);