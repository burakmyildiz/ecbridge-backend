// Register tokens with the new BridgeCitrea contract
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import BridgeCitreaAbi from '../src/abi/BridgeCitrea.json';

async function registerTokens() {
  try {
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const l2Wallet = new Wallet(process.env.CITREA_PRIVATE_KEY!, l2Provider);
    
    const bridgeCitrea = new Contract(
      process.env.CITREA_BRIDGE_ADDRESS!,
      BridgeCitreaAbi,
      l2Wallet
    );
    
    console.log('New BridgeCitrea Address:', process.env.CITREA_BRIDGE_ADDRESS);
    console.log('SP1-Helios Address:', await bridgeCitrea.getLightClient());
    
    // Check if ETH is already registered
    const ethWrapped = await bridgeCitrea.canonicalToWrapped('0x0000000000000000000000000000000000000000');
    console.log('ETH wrapped token:', ethWrapped);
    
    if (ethWrapped === '0x0000000000000000000000000000000000000000') {
      console.log('ETH not registered yet. You need to:');
      console.log('1. Deploy a WrappedERC20 contract for ETH');
      console.log('2. Register it with registerToken(address(0), wrappedETHAddress)');
      
      // You can use the existing WETH_ADDRESS if it's a WrappedERC20 contract
      const wethAddress = process.env.WETH_ADDRESS;
      if (wethAddress) {
        console.log('\nAttempting to register existing WETH contract...');
        try {
          const tx = await bridgeCitrea.registerToken(
            '0x0000000000000000000000000000000000000000', // ETH
            wethAddress
          );
          console.log('Registration transaction:', tx.hash);
          await tx.wait();
          console.log('✅ ETH registered successfully!');
        } catch (error: any) {
          console.error('❌ Registration failed:', error.message);
          console.log('You may need to deploy a new WrappedERC20 for ETH');
        }
      }
    } else {
      console.log('✅ ETH already registered to:', ethWrapped);
    }
    
    // Check current head
    const head = await (await bridgeCitrea.getLightClient()).head();
    console.log('Current SP1-Helios head:', head);
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

registerTokens().catch(console.error);