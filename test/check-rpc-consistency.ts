// Check if execution and consensus RPCs are consistent
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { JsonRpcProvider } from 'ethers';
import { slotToELBlock } from '../src/utils/slotHelper';
import fetch from 'node-fetch';

async function checkRPCConsistency() {
  try {
    console.log('=== Checking RPC Consistency ===');
    
    const executionRPC = process.env.ETH_EXE_RPC_URL!;
    const consensusRPC = process.env.SOURCE_CONSENSUS_RPC_URL!;
    
    console.log(`Execution RPC: ${executionRPC}`);
    console.log(`Consensus RPC: ${consensusRPC}`);
    
    const l1Provider = new JsonRpcProvider(executionRPC);
    
    // Get current execution block
    const currentBlock = await l1Provider.getBlockNumber();
    console.log(`Current execution block: ${currentBlock}`);
    
    // Get current finalized slot from consensus
    console.log('\nGetting finalized header from consensus...');
    const response = await fetch(`${consensusRPC}/eth/v1/beacon/headers/finalized`);
    
    if (!response.ok) {
      console.log(`❌ Consensus RPC error: ${response.status} ${response.statusText}`);
      return;
    }
    
    const consensusData: any = await response.json();
    const finalizedSlot = parseInt(consensusData.data.header.message.slot);
    console.log(`Finalized slot from consensus: ${finalizedSlot}`);
    
    // Map finalized slot to execution block
    const { number: consensusBlock } = await slotToELBlock(consensusRPC, l1Provider, finalizedSlot);
    console.log(`Consensus finalized slot ${finalizedSlot} maps to execution block ${consensusBlock}`);
    
    // Get state roots for comparison
    const executionBlockData = await l1Provider.getBlock(consensusBlock);
    if (!executionBlockData) {
      console.log(`❌ Execution block ${consensusBlock} not found`);
      return;
    }
    
    console.log(`\n=== State Root Comparison ===`);
    console.log(`Block ${consensusBlock}:`);
    console.log(`Execution RPC state root: ${executionBlockData.stateRoot}`);
    
    // Try to get the same block's state root from a different method
    const blockByNumber = await l1Provider.send("eth_getBlockByNumber", [`0x${consensusBlock.toString(16)}`, false]);
    console.log(`eth_getBlockByNumber state root: ${blockByNumber.stateRoot}`);
    
    console.log(`Match: ${executionBlockData.stateRoot === blockByNumber.stateRoot}`);
    
    // Check if there are any recent reorgs
    console.log(`\n=== Recent Block Analysis ===`);
    for (let i = 0; i < 5; i++) {
      const blockNum = currentBlock - i;
      const block = await l1Provider.getBlock(blockNum);
      if (block) {
        console.log(`Block ${blockNum}: ${block.hash} (state: ${block.stateRoot?.substring(0, 10)}...)`);
      }
    }
    
    // Check if the consensus and execution are in sync
    const blocksDifference = currentBlock - consensusBlock;
    console.log(`\nExecution ahead of consensus by ${blocksDifference} blocks`);
    
    if (blocksDifference > 64) {
      console.log(`⚠️  Large gap between execution and consensus finality`);
    }
    
    // Test if we can get consistent proofs from execution RPC
    console.log(`\n=== Testing Proof Consistency ===`);
    
    try {
      // Test on an older, definitely finalized block
      const testBlock = consensusBlock - 32;
      console.log(`Testing proof generation on older block ${testBlock}...`);
      
      const testBlockData = await l1Provider.getBlock(testBlock);
      if (testBlockData) {
        console.log(`Test block ${testBlock} state root: ${testBlockData.stateRoot}`);
        
        const proof = await l1Provider.send("eth_getProof", [
          process.env.ETH_BRIDGE_ADDRESS!,
          [],
          `0x${testBlock.toString(16)}`
        ]);
        
        console.log(`✅ Proof generation successful for block ${testBlock}`);
        console.log(`Proof state root: ${proof.stateRoot}`);
        console.log(`Match: ${testBlockData.stateRoot === proof.stateRoot}`);
        
      }
    } catch (proofError: any) {
      console.log(`❌ Proof generation failed: ${proofError.message}`);
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

checkRPCConsistency().catch(console.error);