// Investigate the exact state root mismatch
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider } from 'ethers';
import SP1HeliosAbi from '../src/abi/SP1Helios.json';
import { slotToELBlock } from '../src/utils/slotHelper';

async function investigateStateMismatch() {
  try {
    console.log('=== Investigating State Root Mismatch ===');
    
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    
    const helios = new Contract(process.env.SP1_HELIOS_ADDRESS!, SP1HeliosAbi, l2Provider);
    
    console.log(`Ethereum RPC: ${process.env.ETH_EXE_RPC_URL}`);
    console.log(`SP1-Helios: ${process.env.SP1_HELIOS_ADDRESS}`);
    
    // Get a recent slot that SP1-Helios has
    const head = await helios.head();
    const headNum = Number(head);
    
    console.log(`\nSP1-Helios head: ${headNum}`);
    
    // Find a slot that has a state root
    let testSlot = null;
    let sp1StateRoot = null;
    
    for (let slot = headNum; slot >= headNum - 100; slot -= 32) {
      try {
        const stateRoot = await helios.headers(slot);
        if (stateRoot && stateRoot !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
          testSlot = slot;
          sp1StateRoot = stateRoot;
          console.log(`Found slot ${slot} with state root: ${stateRoot}`);
          break;
        }
      } catch (e) {
        // Continue to next slot
      }
    }
    
    if (!testSlot || !sp1StateRoot) {
      console.log('❌ No slots found with state roots');
      return;
    }
    
    // Map this slot to an Ethereum block
    console.log(`\nMapping slot ${testSlot} to Ethereum block...`);
    const { number: blockNumber } = await slotToELBlock(process.env.SOURCE_CONSENSUS_RPC_URL!, l1Provider, testSlot);
    console.log(`Slot ${testSlot} maps to Ethereum block ${blockNumber}`);
    
    // Get the ACTUAL state root from Ethereum RPC for this block
    console.log(`\nGetting Ethereum RPC state root for block ${blockNumber}...`);
    const ethBlock = await l1Provider.getBlock(blockNumber);
    
    if (!ethBlock) {
      console.log(`❌ Block ${blockNumber} not found on Ethereum RPC`);
      return;
    }
    
    const ethStateRoot = ethBlock.stateRoot;
    
    if (!ethStateRoot) {
      console.log(`❌ Ethereum block ${blockNumber} has no state root`);
      return;
    }
    
    console.log(`\n=== COMPARISON ===`);
    console.log(`Block Number: ${blockNumber}`);
    console.log(`Slot Number:  ${testSlot}`);
    console.log(`SP1-Helios State Root:  ${sp1StateRoot}`);
    console.log(`Ethereum RPC State Root: ${ethStateRoot}`);
    console.log(`MATCH: ${sp1StateRoot.toLowerCase() === ethStateRoot.toLowerCase()}`);
    
    if (sp1StateRoot.toLowerCase() !== ethStateRoot.toLowerCase()) {
      console.log(`\n❌ MISMATCH CONFIRMED!`);
      console.log(`This means:`);
      console.log(`1. SP1-Helios and Ethereum RPC are looking at different chains/forks`);
      console.log(`2. SP1-Helios was initialized with wrong genesis`);
      console.log(`3. There's a configuration issue with networks`);
      
      // Let's check what network the Ethereum RPC thinks it's on
      console.log(`\n=== Network Information ===`);
      const network = await l1Provider.getNetwork();
      console.log(`Ethereum RPC Network:`);
      console.log(`  Chain ID: ${network.chainId}`);
      console.log(`  Name: ${network.name}`);
      
      console.log(`\nSP1-Helios Genesis Config:`);
      console.log(`  Source Chain ID: ${process.env.SOURCE_CHAIN_ID}`);
      
      if (Number(network.chainId) !== Number(process.env.SOURCE_CHAIN_ID || '0')) {
        console.log(`❌ CHAIN ID MISMATCH!`);
        console.log(`Ethereum RPC is on chain ${network.chainId} but SP1-Helios expects ${process.env.SOURCE_CHAIN_ID}`);
      }
      
      // Check current block vs genesis head
      const currentBlock = await l1Provider.getBlockNumber();
      console.log(`\nBlock Information:`);
      console.log(`  Current block: ${currentBlock}`);
      console.log(`  Genesis head block: ${blockNumber}`);
      console.log(`  Difference: ${currentBlock - blockNumber} blocks`);
      
    } else {
      console.log(`\n✅ STATE ROOTS MATCH!`);
      console.log(`The issue might be with proof generation, not state root mismatch.`);
    }
    
    // Test a proof generation on this block to see the exact error
    console.log(`\n=== Testing Proof Generation ===`);
    try {
      console.log(`Testing eth_getProof on block ${blockNumber}...`);
      
      const bridgeAddress = process.env.ETH_BRIDGE_ADDRESS!;
      const testProof = await l1Provider.send("eth_getProof", [
        bridgeAddress,
        [], // Empty storage keys for account proof only
        `0x${blockNumber.toString(16)}`
      ]);
      
      console.log(`✅ Proof generation works for block ${blockNumber}`);
      console.log(`Account proof has ${testProof.accountProof.length} elements`);
      
    } catch (proofError: any) {
      console.log(`❌ Proof generation failed: ${proofError.message}`);
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

investigateStateMismatch().catch(console.error);