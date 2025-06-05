// Fix WETH contract permissions for the new bridge
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import WrappedERC20Abi from '../src/abi/WrappedERC20.json';

async function fixWETHPermissions() {
  try {
    console.log('=== Fixing WETH Permissions ===');
    
    const l2Provider = new JsonRpcProvider(process.env.CITREA_RPC_URL);
    const l2Wallet = new Wallet(process.env.CITREA_PRIVATE_KEY!, l2Provider);
    
    const wethAddress = process.env.WETH_ADDRESS!;
    const newBridgeAddress = process.env.CITREA_BRIDGE_ADDRESS!;
    
    console.log(`WETH Contract: ${wethAddress}`);
    console.log(`New Bridge: ${newBridgeAddress}`);
    console.log(`Wallet: ${l2Wallet.address}`);
    
    const wethContract = new Contract(wethAddress, WrappedERC20Abi, l2Wallet);
    
    // Check current owner
    try {
      const owner = await wethContract.owner();
      console.log(`Current WETH owner: ${owner}`);
      
      if (owner.toLowerCase() !== l2Wallet.address.toLowerCase()) {
        console.log('❌ Wallet is not the owner of WETH contract');
        console.log('You need to transfer ownership or use the owner wallet');
        
        // Try to transfer ownership if possible
        if (owner === '0x0000000000000000000000000000000000000000') {
          console.log('Owner is zero address, cannot transfer');
        }
        return;
      }
      
      console.log('✅ Wallet is the owner');
      
      // Transfer ownership to the new bridge
      console.log('Transferring ownership to the new bridge...');
      const tx = await wethContract.transferOwnership(newBridgeAddress);
      console.log(`Transaction submitted: ${tx.hash}`);
      
      await tx.wait();
      console.log('✅ Ownership transferred successfully!');
      
      // Verify the transfer
      const newOwner = await wethContract.owner();
      console.log(`New owner: ${newOwner}`);
      
      if (newOwner.toLowerCase() === newBridgeAddress.toLowerCase()) {
        console.log('✅ Ownership transfer confirmed!');
        console.log('The bridge can now mint WETH tokens.');
      } else {
        console.log('❌ Ownership transfer failed');
      }
      
    } catch (ownerError: any) {
      console.log('Error checking/transferring ownership:', ownerError.message);
      
      // Alternative: Check if it's a different type of access control
      try {
        // Try checking if there's a minter role or similar
        const hasRole = await wethContract.hasRole?.('0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6', newBridgeAddress); // MINTER_ROLE
        console.log(`Bridge has minter role: ${hasRole}`);
      } catch (roleError) {
        console.log('No role-based access control found');
      }
    }
    
  } catch (error: any) {
    console.error('Error:', error.message);
  }
}

fixWETHPermissions().catch(console.error);