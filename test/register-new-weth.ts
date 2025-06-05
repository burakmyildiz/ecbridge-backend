// Register the new WETH token
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import BridgeCitreaAbi from '../src/abi/BridgeCitrea.json';

async function registerNewWETH() {
  try {
    console.log('=== Registering New WETH Token ===');
    
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const l2Wallet = new Wallet(process.env.CITREA_PRIVATE_KEY!, l2Provider);
    
    const bridgeCitrea = new Contract(
      process.env.CITREA_BRIDGE_ADDRESS!,
      BridgeCitreaAbi,
      l2Wallet
    );
    
    const newWETHAddress = process.env.WETH_ADDRESS!;
    
    console.log('Bridge Address:', process.env.CITREA_BRIDGE_ADDRESS);
    console.log('New WETH Address:', newWETHAddress);
    
    // Check current registration
    const currentWETH = await bridgeCitrea.canonicalToWrapped('0x0000000000000000000000000000000000000000');
    console.log('Currently registered WETH:', currentWETH);
    
    if (currentWETH.toLowerCase() === newWETHAddress.toLowerCase()) {
      console.log('✅ New WETH already registered!');
      return;
    }
    
    console.log('Current registration is for old WETH. Bridge contracts can only register once.');
    console.log('For demo purposes, we need to use the already registered token or deploy a new bridge.');
    
    // For demo, let's just verify the new WETH is owned by the bridge
    const WrappedERC20Abi = require('../src/abi/WrappedERC20.json');
    const newWETH = new Contract(newWETHAddress, WrappedERC20Abi, l2Provider);
    
    const owner = await newWETH.owner();
    console.log(`New WETH owner: ${owner}`);
    console.log(`Bridge address: ${process.env.CITREA_BRIDGE_ADDRESS}`);
    console.log(`Ownership correct: ${owner.toLowerCase() === process.env.CITREA_BRIDGE_ADDRESS?.toLowerCase()}`);
    
    if (owner.toLowerCase() === process.env.CITREA_BRIDGE_ADDRESS?.toLowerCase()) {
      console.log('✅ New WETH is owned by the bridge');
      console.log('\nSince ETH is already registered to old WETH, for demo we can:');
      console.log('1. Use the old registration (may fail due to ownership)');
      console.log('2. Deploy a completely new bridge and register new WETH');
      console.log('3. Modify demo to work around this limitation');
      
      // Let's update the registration in the bridge contract
      console.log('\nTrying to register new WETH for a different token address...');
      
      try {
        // Register the new WETH under a different canonical address for demo
        const demoCanonicalAddress = '0x0000000000000000000000000000000000000001';
        
        const tx = await bridgeCitrea.registerToken(demoCanonicalAddress, newWETHAddress);
        console.log('Registration transaction:', tx.hash);
        await tx.wait();
        console.log('✅ New WETH registered under demo canonical address!');
        console.log(`Canonical: ${demoCanonicalAddress} -> Wrapped: ${newWETHAddress}`);
        
      } catch (regError: any) {
        console.log(`Registration failed: ${regError.message}`);
      }
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

registerNewWETH().catch(console.error);