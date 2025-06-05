// ECBridge/backend/scripts/fix-stuck-transactions.ts
import mongoose from 'mongoose';
import { TransactionModel, ProofTaskModel, TransactionStatus } from '../src/models';
import config from '../src/config';

async function fixStuckTransactions() {
  try {
    await mongoose.connect(config.mongoUri);
    console.log('Connected to MongoDB');
    
    // Find transactions stuck in proof_generating status
    const stuckTransactions = await TransactionModel.find({
      status: TransactionStatus.PROOF_GENERATING
    });
    
    console.log(`Found ${stuckTransactions.length} stuck transactions`);
    
    for (const tx of stuckTransactions) {
      console.log(`Fixing transaction ${tx.txHash}`);
      
      // Reset to pending so the ethToCitrea relayer can pick it up
      tx.status = TransactionStatus.PENDING;
      tx.timestamps.proofStarted = undefined;
      await tx.save();
      
      // Clean up any related proof tasks
      await ProofTaskModel.deleteOne({ txHash: tx.txHash });
      
      console.log(`Reset transaction ${tx.txHash} to pending`);
    }
    
    // Clean up any stuck proof tasks
    const stuckProofTasks = await ProofTaskModel.find({
      status: 'processing'
    });
    
    console.log(`Found ${stuckProofTasks.length} stuck proof tasks`);
    
    for (const task of stuckProofTasks) {
      await ProofTaskModel.deleteOne({ _id: task._id });
      console.log(`Deleted stuck proof task for ${task.txHash}`);
    }
    
    console.log('Cleanup complete');
    await mongoose.disconnect();
  } catch (error) {
    console.error('Error fixing stuck transactions:', error);
    process.exit(1);
  }
}

fixStuckTransactions();