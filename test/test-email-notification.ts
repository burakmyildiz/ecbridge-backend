// Test email notification registration and sending
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import mongoose from 'mongoose';
import { NotificationPreferenceModel, TransactionModel, TransactionStatus } from '../src/models';

async function testEmailNotificationSetup() {
  try {
    console.log('=== Testing Email Notification Setup ===');
    
    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/ethcitrea');
    console.log('✅ Connected to database');
    
    // Test SMTP configuration
    const smtpConfigured = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    console.log(`✅ SMTP configured: ${smtpConfigured}`);
    console.log(`   Host: ${process.env.SMTP_HOST}`);
    console.log(`   User: ${process.env.SMTP_USER}`);
    console.log(`   Port: ${process.env.SMTP_PORT}`);
    
    // Register a test notification preference
    const testAddress = '0x742d35cc6464c532d70c8b9e9f9d8a2c7e5b8e4f'; // Your wallet address
    const testEmail = 'burak2844@gmail.com'; // Your email
    
    const preference = await NotificationPreferenceModel.findOneAndUpdate(
      {
        address: testAddress.toLowerCase(),
        type: 'email',
        destination: testEmail
      }, 
      { 
        $set: {
          address: testAddress.toLowerCase(),
          type: 'email',
          destination: testEmail,
          active: true,
          lastNotified: null,
          notifyRetryCount: 0
        }
      },
      { upsert: true, new: true }
    );
    
    console.log(`✅ Registered notification preference: ${preference._id}`);
    console.log(`   Address: ${preference.address}`);
    console.log(`   Email: ${preference.destination}`);
    console.log(`   Active: ${preference.active}`);
    
    // Check if there are any confirmed transactions for this address
    const confirmedTx = await TransactionModel.findOne({
      $or: [
        { sender: testAddress.toLowerCase() },
        { recipient: testAddress.toLowerCase() }
      ],
      status: TransactionStatus.CONFIRMED,
      notificationSent: { $ne: true }
    });
    
    if (confirmedTx) {
      console.log(`✅ Found confirmed transaction that needs notification: ${confirmedTx.txHash}`);
      console.log(`   Status: ${confirmedTx.status}`);
      console.log(`   Notification sent: ${confirmedTx.notificationSent}`);
    } else {
      console.log(`ℹ️  No confirmed transactions found for this address that need notifications`);
    }
    
    // Count all notification preferences
    const allPreferences = await NotificationPreferenceModel.find({ active: true });
    console.log(`✅ Total active notification preferences: ${allPreferences.length}`);
    
    console.log('\n🎯 Setup complete! The notification worker should now:');
    console.log('   1. Check for confirmed transactions every 60 seconds');
    console.log('   2. Send email notifications to registered addresses');
    console.log('   3. Mark transactions as notificationSent: true after sending');
    
    console.log('\n📧 To test: Complete a bridge transaction and wait for email notification');
    
  } catch (error: any) {
    console.error('❌ Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

testEmailNotificationSetup().catch(console.error);