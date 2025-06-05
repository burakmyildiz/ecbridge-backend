// backend/scripts/check-deposit-status.ts
import { ethers } from "ethers";
import dotenv from "dotenv";
import path from "path";
import mongoose from "mongoose";
import { TransactionModel, ProofTaskModel } from "../src/models";
import config from "../src/config";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function checkDepositStatus() {
  console.log("🔍 Checking deposit status...\n");
  
  // Connect to MongoDB
  await mongoose.connect(config.mongoUri);
  console.log("Connected to MongoDB\n");
  
  // Get all transactions
  const transactions = await TransactionModel.find().sort({ "timestamps.initiated": -1 });
  
  console.log(`Found ${transactions.length} transactions\n`);
  
  for (const tx of transactions) {
    console.log(`Transaction: ${tx.txHash}`);
    console.log(`  Status: ${tx.status}`);
    console.log(`  From Chain: ${tx.fromChain}`);
    console.log(`  To Chain: ${tx.toChain}`);
    console.log(`  Amount: ${tx.amount}`);
    console.log(`  Initiated: ${tx.timestamps.initiated}`);
    
    if (tx.timestamps.proofStarted) {
      console.log(`  Proof Started: ${tx.timestamps.proofStarted}`);
    }
    if (tx.timestamps.proofGenerated) {
      console.log(`  Proof Generated: ${tx.timestamps.proofGenerated}`);
    }
    if (tx.timestamps.submitted) {
      console.log(`  Submitted: ${tx.timestamps.submitted}`);
    }
    if (tx.timestamps.confirmed) {
      console.log(`  Confirmed: ${tx.timestamps.confirmed}`);
    }
    if (tx.error) {
      console.log(`  Error: ${tx.error}`);
    }
    
    // Check for proof task
    const proofTask = await ProofTaskModel.findOne({ txHash: tx.txHash });
    if (proofTask) {
      console.log(`  Proof Task Status: ${proofTask.status}`);
      console.log(`  Proof Task Block: ${proofTask.blockNumber}`);
      if (proofTask.error) {
        console.log(`  Proof Task Error: ${proofTask.error}`);
      }
    }
    
    console.log("-------------------\n");
  }
  
  // Now check specific deposits in the bridge contract
  const citreaProvider = new ethers.JsonRpcProvider(process.env.CITREA_RPC_URL);
  const bridgeAddress = process.env.CITREA_BRIDGE_ADDRESS;
  const bridgeAbi = ["function isProcessed(uint256) view returns (bool)"];
  const bridge = new ethers.Contract(bridgeAddress!, bridgeAbi, citreaProvider);
  
  // Check if deposits are processed on-chain
  console.log("Checking on-chain deposit status...");
  for (let nonce = 31; nonce <= 35; nonce++) {
    const isProcessed = await bridge.isProcessed(nonce);
    console.log(`Deposit #${nonce}: ${isProcessed ? '✅ Processed' : '❌ Not Processed'}`);
  }
  
  mongoose.disconnect();
}

checkDepositStatus().catch(console.error);