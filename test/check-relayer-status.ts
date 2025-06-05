// Check if relayer is detecting and processing events
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider } from 'ethers';
import BridgeEthAbi from '../src/abi/BridgeEth.json';
import BridgeCitreaAbi from '../src/abi/BridgeCitrea.json';

async function checkRelayerStatus() {
  try {
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const bridgeEthAddress = process.env.ETH_BRIDGE_ADDRESS!;
    const bridgeCitreaAddress = process.env.CITREA_BRIDGE_ADDRESS!;
    
    console.log('=== Relayer Status Check ===');
    console.log('L1 Bridge:', bridgeEthAddress);
    console.log('L2 Bridge:', bridgeCitreaAddress);
    
    // Check recent deposit events
    const bridgeEth = new Contract(bridgeEthAddress, BridgeEthAbi, l1Provider);
    const bridgeCitrea = new Contract(bridgeCitreaAddress, BridgeCitreaAbi, l2Provider);
    
    const currentBlock = await l1Provider.getBlockNumber();
    const fromBlock = currentBlock - 500; // Last 500 blocks
    
    console.log(`\nScanning blocks ${fromBlock} to ${currentBlock} for deposits...`);
    
    // Get all deposit events
    const ethEvents = await bridgeEth.queryFilter(
      bridgeEth.filters.DepositETH(),
      fromBlock,
      currentBlock
    );
    
    const erc20Events = await bridgeEth.queryFilter(
      bridgeEth.filters.DepositERC20(),
      fromBlock,
      currentBlock
    );
    
    const allEvents = [...ethEvents, ...erc20Events].sort((a, b) => 
      a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex
    );
    
    console.log(`Found ${allEvents.length} deposit events in recent blocks`);
    
    if (allEvents.length > 0) {
      console.log('\nRecent Deposits:');
      for (const event of allEvents.slice(-5)) { // Show last 5
        const log = bridgeEth.interface.parseLog({
          topics: [...event.topics],
          data: event.data
        });
        
        if (log) {
          const { nonce, amount, from } = log.args;
          console.log(`  Nonce ${nonce}: ${amount / BigInt(10**18)} ETH from ${from} (Block: ${event.blockNumber}, Tx: ${event.transactionHash})`);
          
          // Check if processed on L2
          try {
            const isProcessed = await bridgeCitrea.isProcessed(nonce);
            console.log(`    Status on L2: ${isProcessed ? '✅ Processed' : '❌ Not Processed'}`);
          } catch (e: any) {
            console.log(`    Status on L2: ❌ Error checking - ${e.message}`);
          }
        }
      }
    }
    
    // Check if specific nonce 53 is processed
    console.log('\n=== Checking Nonce 53 (Your Transaction) ===');
    try {
      const isProcessed = await bridgeCitrea.isProcessed(53);
      console.log(`Nonce 53 processed on L2: ${isProcessed ? '✅ Yes' : '❌ No'}`);
      
      // Get the deposit hash for nonce 53
      const depositHash = await bridgeEth.deposits(53);
      console.log(`Deposit hash on L1: ${depositHash}`);
      
      if (depositHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        console.log('❌ Nonce 53 not found in L1 bridge contract!');
      }
    } catch (error: any) {
      console.log(`Error checking nonce 53: ${error.message}`);
    }
    
    // Check L2 bridge state
    console.log('\n=== L2 Bridge State ===');
    try {
      const lightClient = await bridgeCitrea.getLightClient();
      console.log(`Light client address: ${lightClient}`);
      
      const minFinality = await bridgeCitrea.minSlotFinality();
      console.log(`Min slot finality: ${minFinality}`);
    } catch (error: any) {
      console.log(`Error getting L2 state: ${error.message}`);
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

checkRelayerStatus().catch(console.error);