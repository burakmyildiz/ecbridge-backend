// Debug why the relayer isn't picking up the transaction
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider } from 'ethers';
import BridgeEthAbi from '../src/abi/BridgeEth.json';
import BridgeCitreaAbi from '../src/abi/BridgeCitrea.json';

async function debugRelayer() {
  try {
    console.log('=== Debugging Relayer Issues ===');
    
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    
    const bridgeEth = new Contract(process.env.ETH_BRIDGE_ADDRESS!, BridgeEthAbi, l1Provider);
    const bridgeCitrea = new Contract(process.env.CITREA_BRIDGE_ADDRESS!, BridgeCitreaAbi, l2Provider);
    
    // Check what blocks the relayer should be scanning
    const currentBlock = await l1Provider.getBlockNumber();
    const txBlock = 8477237;
    const nonce = 54;
    
    console.log(`Current L1 block: ${currentBlock}`);
    console.log(`Transaction block: ${txBlock}`);
    console.log(`Blocks behind: ${currentBlock - txBlock}`);
    
    // Check if the relayer has scanned this block range
    console.log('\n=== Checking Recent Deposit Events ===');
    
    // Look for events in a range around the transaction
    const fromBlock = txBlock - 10;
    const toBlock = Math.min(txBlock + 10, currentBlock);
    
    console.log(`Scanning blocks ${fromBlock} to ${toBlock}...`);
    
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
    
    const allEvents = [...ethEvents, ...erc20Events];
    console.log(`Found ${allEvents.length} deposit events in this range`);
    
    for (const event of allEvents) {
      const log = bridgeEth.interface.parseLog({
        topics: [...event.topics],
        data: event.data
      });
      
      if (log) {
        const { nonce: eventNonce } = log.args;
        const eventNonceNum = Number(eventNonce);
        
        console.log(`\nEvent - Nonce: ${eventNonce}, Block: ${event.blockNumber}, Tx: ${event.transactionHash}`);
        
        // Check if this nonce is processed on L2
        try {
          const isProcessed = await bridgeCitrea.isProcessed(eventNonce);
          console.log(`  L2 Status: ${isProcessed ? 'PROCESSED' : 'NOT PROCESSED'}`);
          
          if (eventNonceNum === nonce) {
            console.log(`  >>> THIS IS YOUR TRANSACTION <<<`);
            if (!isProcessed) {
              console.log(`  >>> RELAYER SHOULD PROCESS THIS <<<`);
            }
          }
        } catch (error: any) {
          console.log(`  L2 Status: ERROR - ${error.message}`);
        }
      }
    }
    
    // Check relayer configuration
    console.log('\n=== Checking Relayer Configuration ===');
    console.log(`L1 Bridge: ${process.env.ETH_BRIDGE_ADDRESS}`);
    console.log(`L2 Bridge: ${process.env.CITREA_BRIDGE_ADDRESS}`);
    console.log(`SP1-Helios: ${process.env.SP1_HELIOS_ADDRESS}`);
    
    // Check if the relayer is using the right contracts
    const lightClientAddr = await bridgeCitrea.getLightClient();
    console.log(`L2 Bridge points to light client: ${lightClientAddr}`);
    console.log(`Environment SP1-Helios: ${process.env.SP1_HELIOS_ADDRESS}`);
    console.log(`Addresses match: ${lightClientAddr.toLowerCase() === process.env.SP1_HELIOS_ADDRESS?.toLowerCase()}`);
    
    // Check specific nonce status
    console.log(`\n=== Checking Nonce ${nonce} Status ===`);
    
    try {
      // Check if nonce exists on L1
      const depositHash = await bridgeEth.deposits(nonce);
      console.log(`L1 deposit hash for nonce ${nonce}: ${depositHash}`);
      
      if (depositHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        console.log(`❌ Nonce ${nonce} not found in L1 bridge!`);
      } else {
        console.log(`✅ Nonce ${nonce} exists on L1`);
      }
      
      // Check L2 status
      const isProcessed = await bridgeCitrea.isProcessed(nonce);
      console.log(`L2 processed status for nonce ${nonce}: ${isProcessed}`);
      
    } catch (error: any) {
      console.log(`Error checking nonce ${nonce}: ${error.message}`);
    }
    
    // Check if the relayer might be looking at old block ranges
    console.log('\n=== Potential Issues ===');
    console.log('1. Check backend logs for relayer scanning messages');
    console.log('2. Relayer might be scanning wrong block range');
    console.log('3. Relayer might have failed to detect the event');
    console.log('4. Relayer might be waiting for more confirmations');
    console.log(`5. Current confirmations: ${currentBlock - txBlock}`);
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

debugRelayer().catch(console.error);