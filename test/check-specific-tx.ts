// Check specific transaction details
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider } from 'ethers';
import BridgeEthAbi from '../src/abi/BridgeEth.json';

async function checkTransaction(txHash: string) {
  try {
    const l1Provider = new JsonRpcProvider(process.env.ETH_EXE_RPC_URL);
    const bridgeEthAddress = process.env.ETH_BRIDGE_ADDRESS!;
    
    console.log('Checking transaction:', txHash);
    console.log('Expected Bridge Address:', bridgeEthAddress);
    
    // Get transaction receipt
    const receipt = await l1Provider.getTransactionReceipt(txHash);
    if (!receipt) {
      console.log('Transaction not found!');
      return;
    }
    
    console.log('\nTransaction Details:');
    console.log('To:', receipt.to);
    console.log('Status:', receipt.status === 1 ? 'Success' : 'Failed');
    console.log('Block:', receipt.blockNumber);
    console.log('Is correct bridge?', receipt.to?.toLowerCase() === bridgeEthAddress.toLowerCase());
    
    // Parse logs
    const bridgeEth = new Contract(bridgeEthAddress, BridgeEthAbi, l1Provider);
    
    console.log('\nChecking for deposit events...');
    let depositFound = false;
    
    for (const log of receipt.logs) {
      try {
        // Check if this log is from the bridge contract
        if (log.address.toLowerCase() === bridgeEthAddress.toLowerCase()) {
          const parsed = bridgeEth.interface.parseLog({
            topics: [...log.topics],
            data: log.data
          });
          
          if (parsed && (parsed.name === 'DepositETH' || parsed.name === 'DepositERC20')) {
            depositFound = true;
            console.log(`\n✅ Deposit Event Found: ${parsed.name}`);
            const { nonce, amount, from, to, token } = parsed.args;
            console.log(`  Nonce: ${nonce}`);
            console.log(`  Amount: ${amount} (${amount / BigInt(10**18)} ETH)`);
            console.log(`  From: ${from}`);
            console.log(`  To: ${to}`);
            if (token) console.log(`  Token: ${token}`);
          }
        }
      } catch (e) {
        // Not a bridge event
      }
    }
    
    if (!depositFound) {
      console.log('\n❌ No deposit events found in this transaction');
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

const txHash = process.argv[2] || '0x973a67914e55b2d3e55d108d85e533a0d65175ff7154397b2b41e3182bbc9624';
checkTransaction(txHash).catch(console.error);