// ECBridge/backend/src/notifications/worker.ts
import mongoose from 'mongoose';
import nodemailer from 'nodemailer';
import { TransactionModel, NotificationPreferenceModel, TransactionStatus } from '../models';
import config from '../config';
import logger from '../utils/logger';

if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
  logger.warn('SMTP not fully configured. Email notifications will not be sent.');
}

// Email transporter setup
const transporter = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    })
  : null;


async function sendNotification(preference: any, transaction: any): Promise<boolean> {
  try {
    switch (preference.type) {
      case 'email':
        await sendEmailNotification(preference, transaction);
        break;
      // Add other notification types here (push, SMS, etc.)
      default:
        logger.warn(`Unsupported notification type: ${preference.type}`);
        return false;
    }
    
    // Update notification record
    preference.lastNotified = new Date();
    preference.notifyRetryCount = 0;
    await preference.save();
    
    return true;
  } catch (error) {
    logger.error(`Error sending notification: ${error}`);
    
    // Increment retry count
    preference.notifyRetryCount = (preference.notifyRetryCount || 0) + 1;
    await preference.save();
    
    return false;
  }
}

async function sendEmailNotification(preference: any, transaction: any): Promise<boolean> {
  if (!transporter) {
    logger.error('Email notification failed: SMTP not configured');
    return false;
  }
  // Get token symbol if available
  let tokenSymbol = transaction.token;
  try {
    const tokenMatch = await mongoose.connection.collection('tokens').findOne({
      address: transaction.token,
      chain: transaction.fromChain
    });
    
    if (tokenMatch) {
      tokenSymbol = tokenMatch.symbol;
    }
  } catch (error) {
    logger.error(`Error fetching token details: ${error}`);
  }
  
  // Format the amount for display
  const amount = parseFloat(transaction.amount).toLocaleString();
  
  // Construct email
  const mailOptions = {
    from: process.env.SMTP_FROM || 'bridge@example.com',
    to: preference.destination,
    subject: `Your bridge transaction is complete!`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
        <h2 style="color: #4f46e5;">Bridge Transaction Complete</h2>
        <p>Your tokens have been successfully bridged to ${transaction.toChain}!</p>
        
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Amount:</strong> ${amount} ${tokenSymbol}</p>
          <p><strong>From:</strong> ${transaction.fromChain}</p>
          <p><strong>To:</strong> ${transaction.toChain}</p>
          <p><strong>Recipient Address:</strong> ${transaction.recipient}</p>
          <p><strong>Transaction Hash:</strong> ${transaction.txHash}</p>
          ${transaction.destinationTxHash ? `<p><strong>Destination TX:</strong> ${transaction.destinationTxHash}</p>` : ''}
        </div>
        
        <p>Thank you for using our bridge service!</p>
        
        <div style="margin-top: 30px; font-size: 12px; color: #666;">
          <p>If you did not initiate this transaction, please contact support immediately.</p>
        </div>
      </div>
    `
  };
  
  // Send the email
  await transporter.sendMail(mailOptions);
  logger.info(`Email notification sent to ${preference.destination} for transaction ${transaction.txHash}`);
  
  // Add this return statement to fix the TypeScript error
  return true;
}

async function processNotifications(): Promise<void> {
  try {
    // Find transactions that were just confirmed but notifications haven't been sent
    const newlyCompletedTransactions = await TransactionModel.find({
      status: TransactionStatus.CONFIRMED,
      'timestamps.confirmed': { $exists: true },
      notificationSent: { $ne: true }
    });
    
    logger.info(`Found ${newlyCompletedTransactions.length} new completed transactions to notify`);
    
    for (const transaction of newlyCompletedTransactions) {
      // Find notification preferences for this transaction or user
      const sender = transaction.sender.toLowerCase();
      const preferences = await NotificationPreferenceModel.find({
        $or: [
          { transactionHash: transaction.txHash, active: true },
          { address: sender, active: true }
        ]
      });
      
      // If there are no preferences, continue to next transaction
      if (preferences.length === 0) {
        logger.info(`No active notification preferences for ${transaction.txHash}; marking as notified.`);
        transaction.notificationSent = true;
        await transaction.save();
        continue; 
      }
      
      let allSuccessful = true;
      
      // Send notifications according to each preference
      for (const preference of preferences) {
        const success = await sendNotification(preference, transaction);
        if (!success) {
          allSuccessful = false;
        }
      }
      
      // Mark transaction as notified if all notifications were successful
      if (allSuccessful) {
        transaction.notificationSent = true;
        await transaction.save();
      }
    }
    
    // Process failed notification retries with exponential backoff
    const maxRetryCount = 5;
    
    for (let retryCount = 1; retryCount <= maxRetryCount; retryCount++) {
      // Calculate retry time - exponential backoff
      const retryTimeMinutes = Math.pow(2, retryCount - 1) * 5; // 5min, 10min, 20min, 40min, 80min
      const cutoffTime = new Date(Date.now() - retryTimeMinutes * 60 * 1000);
      
      // Find notifications to retry
      const retryPreferences = await NotificationPreferenceModel.find({
        notifyRetryCount: retryCount,
        lastNotified: { $lt: cutoffTime }
      });
      
      for (const preference of retryPreferences) {
        // Find the transaction
        const transaction = preference.transactionHash 
          ? await TransactionModel.findOne({ txHash: preference.transactionHash })
          : await TransactionModel.findOne({ 
              $or: [{ sender: preference.address }, { recipient: preference.address }],
              status: TransactionStatus.CONFIRMED
            }).sort({ 'timestamps.confirmed': -1 });
        
        if (transaction && transaction.status === TransactionStatus.CONFIRMED) {
          await sendNotification(preference, transaction);
        }
      }
    }
    
  } catch (error) {
    logger.error(`Error in notification worker: ${error}`);
  }
}

export async function startNotificationWorker(): Promise<void> {
  // Connect to MongoDB if not already connected
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(config.mongoUri);
    logger.info(`Notification worker connected to MongoDB at ${config.mongoUri}`);
  }
  
  // Process notifications immediately on startup
  await processNotifications();
  
  // Schedule to run every minute
  setInterval(processNotifications, 60 * 1000);
  
  logger.info('Notification worker started');
}

// Allow direct execution for testing/debugging
if (require.main === module) {
  startNotificationWorker()
    .then(() => logger.info('Notification worker running...'))
    .catch(error => {
      logger.error(`Failed to start notification worker: ${error}`);
      process.exit(1);
    });
}