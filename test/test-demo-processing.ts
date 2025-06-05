// Test the demo processing on existing transaction
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import BridgeCitreaAbi from '../src/abi/BridgeCitrea.json';
import BridgeEthAbi from '../src/abi/BridgeEth.json';
import { TransactionModel, TransactionStatus } from '../src/models';
import mongoose from 'mongoose';

async function testDemoProcessing() {
  try {
    console.log('=== Testing Demo Processing ===');
    
    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ethcitrea');
    
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const l2Wallet = new Wallet(process.env.CITREA_PRIVATE_KEY!, l2Provider);
    
    const bridgeEth = new Contract(process.env.ETH_BRIDGE_ADDRESS!, BridgeEthAbi, l1Provider);
    const bridgeCitrea = new Contract(process.env.CITREA_BRIDGE_ADDRESS!, BridgeCitreaAbi, l2Wallet);
    
    const txHash = '0x60cd8e69c69a064ce211cdfd209ef8488088da52f5579ab68baed6e44b3dc72a';
    const nonce = 54;
    
    console.log(`Testing processing of nonce ${nonce} (${txHash})`);
    
    // Check if already processed
    const isProcessed = await bridgeCitrea.isProcessed(nonce);
    console.log(`Already processed on new contract: ${isProcessed}`);
    
    if (isProcessed) {
      console.log('✅ Already processed with demo function!');
      return;
    }
    
    // Get transaction receipt and parse deposit event
    const receipt = await l1Provider.getTransactionReceipt(txHash);
    if (!receipt) {
      console.log('❌ Transaction not found');
      return;
    }
    
    let depositEvent;
    for (const log of receipt.logs) {
      try {
        const parsed = bridgeEth.interface.parseLog({
          topics: [...log.topics],
          data: log.data
        });
        if (parsed && parsed.name === 'DepositETH') {
          depositEvent = parsed;
          break;
        }
      } catch (e) {}
    }
    
    if (!depositEvent) {
      console.log('❌ Deposit event not found');
      return;
    }
    
    const { amount, from, to } = depositEvent.args;
    
    console.log(`Deposit details:`);
    console.log(`  From: ${from}`);
    console.log(`  To: ${to}`);
    console.log(`  Amount: ${amount} (${amount / BigInt(10**15)} mETH)`);
    console.log(`  Nonce: ${nonce}`);
    
    // Create deposit struct - use demo canonical address
    const depositStruct = {
      from,
      to,
      token: '0x0000000000000000000000000000000000000001', // Demo canonical address for ETH
      amount,
      nonce
    };
    
    console.log('\nTesting demo processing...');
    
    try {
      // Estimate gas first
      const gasEstimate = await bridgeCitrea.finaliseDepositDemo.estimateGas(depositStruct);
      console.log(`Gas estimate: ${gasEstimate}`);
      
      // Call the demo function
      const tx = await bridgeCitrea.finaliseDepositDemo(depositStruct, {
        gasLimit: gasEstimate + BigInt(50000)
      });
      
      console.log(`🚀 Demo transaction submitted: ${tx.hash}`);
      console.log('Waiting for confirmation...');
      
      const txReceipt = await tx.wait();
      console.log(`✅ SUCCESS! Demo processing confirmed in block ${txReceipt!.blockNumber}`);
      
      // Update database
      const transaction = await TransactionModel.findOne({ txHash });
      if (transaction) {
        transaction.status = TransactionStatus.CONFIRMED;
        transaction.destinationTxHash = tx.hash;
        transaction.timestamps.confirmed = new Date();
        await transaction.save();
        console.log('✅ Database updated');
      }
      
      console.log('🎉 Demo processing successful! Your bridge is working for the demo.');
      
    } catch (error: any) {
      console.error(`❌ Demo processing failed: ${error.message}`);
      if (error.data) {
        console.error('Error data:', error.data);
      }
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

testDemoProcessing().catch(console.error);