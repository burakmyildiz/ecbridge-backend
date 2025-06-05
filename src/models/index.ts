// ECBridge/backend/src/models/index.ts
import mongoose, { Schema, Document } from 'mongoose';

export enum TransactionStatus {
  PENDING = 'pending',
  PROOF_GENERATING = 'proof_generating',
  PROOF_GENERATED = 'proof_generated',
  SUBMITTED = 'submitted',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
  EXPIRED = 'expired'
}

export enum Chain {
  ETHEREUM = 'ethereum',
  CITREA = 'citrea'
}

export enum NotificationType {
  EMAIL = 'email',
  PUSH = 'push',
  TELEGRAM = 'telegram',
  SMS = 'sms'
}

export interface ITransaction extends Document {
  txHash: string;
  fromChain: Chain;
  toChain: Chain;
  sender: string;
  recipient: string;
  token: string;
  amount: string;
  proofData?: string;
  destinationTxHash?: string;
  status: TransactionStatus;
  retries: number;
  error?: string;
  notificationSent?: boolean; // Added this field for tracking notification status
  timestamps: {
    initiated: Date;
    proofStarted?: Date;
    proofGenerated?: Date;
    submitted?: Date;
    confirmed?: Date;
    failed?: Date;
  };
}

export interface IToken extends Document {
  symbol: string;
  name: string;
  address: string;
  chain: Chain;
  decimals: number;
  isWhitelisted: boolean;
}

export interface IProofTask extends Document {
  txHash: string;
  blockNumber: number;
  fromChain: Chain;
  toChain: Chain;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  proofData?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  processedAt?: Date;
}

export interface INotificationPreference extends Document {
  address: string;               // User's wallet address
  transactionHash?: string;      // Optional: specific transaction to be notified about
  type: NotificationType;        // Email, push, telegram, etc.
  destination: string;           // Email address, FCM token, telegram ID, etc.
  active: boolean;               // Whether notifications are active
  lastNotified?: Date;           // When the last notification was sent
  notifyRetryCount?: number;     // For tracking failed notification attempts
}

const TransactionSchema: Schema = new Schema({
  txHash: { type: String, required: true, index: true },
  fromChain: { type: String, enum: Object.values(Chain), required: true },
  toChain: { type: String, enum: Object.values(Chain), required: true },
  sender: { type: String, required: true, index: true },
  recipient: { type: String, required: true, index: true },
  token: { type: String, required: true },
  amount: { type: String, required: true },
  proofData: { type: String },
  destinationTxHash: { type: String, index: true },
  status: { 
    type: String, 
    enum: Object.values(TransactionStatus), 
    default: TransactionStatus.PENDING,
    required: true 
  },
  retries: { type: Number, default: 0 },
  error: { type: String },
  notificationSent: { type: Boolean, default: false }, // Added field to schema
  timestamps: {
    initiated: { type: Date, required: true, default: Date.now },
    proofStarted: { type: Date },
    proofGenerated: { type: Date },
    submitted: { type: Date },
    confirmed: { type: Date },
    failed: { type: Date }
  }
}, { timestamps: true });

const TokenSchema: Schema = new Schema({
  symbol: { type: String, required: true },
  name: { type: String, required: true },
  address: { type: String, required: true, index: true },
  chain: { type: String, enum: Object.values(Chain), required: true },
  decimals: { type: Number, required: true, default: 18 },
  isWhitelisted: { type: Boolean, required: true, default: false }
}, { timestamps: true });

TokenSchema.index({ address: 1, chain: 1 }, { unique: true });

const ProofTaskSchema: Schema = new Schema({
  txHash: { type: String, required: true, unique: true },
  blockNumber: { type: Number, required: true },
  fromChain: { type: String, enum: Object.values(Chain), required: true },
  toChain: { type: String, enum: Object.values(Chain), required: true },
  status: { 
    type: String, 
    enum: ['pending', 'processing', 'completed', 'failed'], 
    default: 'pending',
    required: true 
  },
  proofData: { type: String },
  error: { type: String },
  processedAt: { type: Date }
}, { timestamps: true });

// Check this part in models/index.ts
export interface INotificationPreference extends Document {
  address: string;               // User's wallet address
  transactionHash?: string;      // Optional: specific transaction to be notified about
  type: NotificationType;        // Email, push, telegram, etc.
  destination: string;           // Email address, FCM token, telegram ID, etc.
  active: boolean;               // Whether notifications are active
  lastNotified?: Date;           // When the last notification was sent
  notifyRetryCount?: number;     // For tracking failed notification attempts
}

const NotificationPreferenceSchema: Schema = new Schema({
  address: { type: String, required: true, index: true },
  transactionHash: { type: String, index: true },
  type: { 
    type: String, 
    enum: Object.values(NotificationType), 
    required: true 
  },
  destination: { type: String, required: true },
  active: { type: Boolean, default: true },
  lastNotified: { type: Date },
  notifyRetryCount: { type: Number, default: 0 }
}, { timestamps: true });
NotificationPreferenceSchema.index({ address: 1, transactionHash: 1 });

export const TransactionModel = mongoose.model<ITransaction>('Transaction', TransactionSchema);
export const TokenModel = mongoose.model<IToken>('Token', TokenSchema);
export const ProofTaskModel = mongoose.model<IProofTask>('ProofTask', ProofTaskSchema);
export const NotificationPreferenceModel = mongoose.model<INotificationPreference>('NotificationPreference', NotificationPreferenceSchema);