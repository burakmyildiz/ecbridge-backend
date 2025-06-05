// Check what the relayer sees
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider } from 'ethers';
import BridgeEthAbi from '../src/abi/BridgeEth.json';

async function checkRelayerView() {
  try {
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const bridgeEthAddress = process.env.ETH_BRIDGE_ADDRESS!;
    const txHash = '0x332bbc4c141fb882087314e7308bd9e7af5ae5744f54bf98b987f5b690d302b4';
    
    console.log('Bridge Address:', bridgeEthAddress);
    
    // Get transaction receipt
    const receipt = await l1Provider.getTransactionReceipt(txHash);
    if (!receipt) {
      console.log('Transaction not found!');
      return;
    }
    
    console.log('Transaction found in block:', receipt.blockNumber);
    console.log('Transaction status:', receipt.status === 1 ? 'Success' : 'Failed');
    
    // Check if it's to the bridge contract
    console.log('Transaction to:', receipt.to);
    console.log('Is bridge transaction?', receipt.to?.toLowerCase() === bridgeEthAddress.toLowerCase());
    
    // Parse logs
    const bridgeEth = new Contract(bridgeEthAddress, BridgeEthAbi, l1Provider);
    console.log('\nLogs in transaction:');
    
    for (const log of receipt.logs) {
      try {
        const parsed = bridgeEth.interface.parseLog({
          topics: [...log.topics],
          data: log.data
        });
        
        if (parsed) {
          console.log(`\nEvent: ${parsed.name}`);
          console.log('Args:', parsed.args);
          
          if (parsed.name === 'DepositETH' || parsed.name === 'DepositERC20') {
            const { nonce, amount, from, to } = parsed.args;
            console.log(`Deposit detected!`);
            console.log(`  Nonce: ${nonce}`);
            console.log(`  Amount: ${amount}`);
            console.log(`  From: ${from}`);
            console.log(`  To: ${to}`);
          }
        }
      } catch (e) {
        // Not a bridge event
      }
    }
    
    // Check the latest block the relayer might be scanning
    const currentBlock = await l1Provider.getBlockNumber();
    console.log('\nCurrent block:', currentBlock);
    console.log('Blocks since transaction:', currentBlock - receipt.blockNumber);
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

checkRelayerView().catch(console.error);