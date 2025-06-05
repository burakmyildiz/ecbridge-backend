// ECBridge/backend/src/index.ts
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import mongoose from 'mongoose';
import apiRoutes from './api/routes';
import { relayerService } from './relayer';
import { proofGenerator } from './proof-generator';
import config from './config';
import logger from './utils/logger';

//import startEthToCitreaRelayer from "./relayer/ethToCitrea";
//import startDemoEthToCitreaRelayer from "./relayer/demoEthToCitrea";
//import startDemoRealRelayer from "./relayer/demoEthToCitreaReal";
import startDemoRealRelayer from "./relayer/demoEthToCitreaRealFinal";
import { startNotificationWorker } from "./notifications/worker";


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(config.apiBasePath, apiRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'EthCitreaBridge API is running' });
});

io.on('connection', (socket) => {
  logger.info(`Socket client connected: ${socket.id}`);
  
  socket.on('subscribe', (data) => {
    if (data.channel === 'transactions' && data.address) {
      logger.info(`Client ${socket.id} subscribed to transactions for ${data.address}`);
      socket.join(`address:${data.address}`);
    } else if (data.channel === 'status') {
      logger.info(`Client ${socket.id} subscribed to system status updates`);
      socket.join('status');
    } else if (data.channel === 'finality' && data.txHash) {
      logger.info(`Client ${socket.id} subscribed to finality updates for ${data.txHash}`);
      socket.join(`finality:${data.txHash}`);
    } else if (data.channel === 'finality') {
      logger.info(`Client ${socket.id} subscribed to all finality updates`);
      socket.join('finality');
    }
  });
  
  socket.on('unsubscribe', (data) => {
    if (data.channel === 'transactions' && data.address) {
      logger.info(`Client ${socket.id} unsubscribed from transactions for ${data.address}`);
      socket.leave(`address:${data.address}`);
    } else if (data.channel === 'status') {
      logger.info(`Client ${socket.id} unsubscribed from system status updates`);
      socket.leave('status');
    } else if (data.channel === 'finality' && data.txHash) {
      logger.info(`Client ${socket.id} unsubscribed from finality updates for ${data.txHash}`);
      socket.leave(`finality:${data.txHash}`);
    } else if (data.channel === 'finality') {
      logger.info(`Client ${socket.id} unsubscribed from all finality updates`);
      socket.leave('finality');
    }
  });
  
  socket.on('disconnect', () => {
    logger.info(`Socket client disconnected: ${socket.id}`);
  });
});

export const publishTransactionUpdate = (transaction: any) => {
  io.to(`address:${transaction.sender}`).emit('transaction', {
    type: 'update',
    data: transaction
  });
  
  io.to(`address:${transaction.recipient}`).emit('transaction', {
    type: 'update',
    data: transaction
  });
};

export const publishStatusUpdate = (component: string, status: string, message: string) => {
  // Emit to all subscribers of the specific component status
  io.to(`${component}`).emit('status', {
    component,
    status,
    message,
    timestamp: new Date()
  });
  
  // If this is a finality update for a specific transaction
  if (component === 'finality' && message) {
    try {
      const data = JSON.parse(message);
      if (data.txHash) {
        // Emit to subscribers of this specific transaction
        io.to(`finality:${data.txHash}`).emit('finalityUpdate', {
          ...data,
          timestamp: new Date()
        });
      }
    } catch (e) {
      // Not JSON or doesn't have txHash, just continue
    }
  }
  
  // Also emit to the general status channel
  io.to('status').emit('status', {
    component,
    status,
    message,
    timestamp: new Date()
  });
};

process.on('SIGINT', async () => {
  logger.info('Received SIGINT signal. Shutting down gracefully...');
  
  await relayerService.stop();
  await proofGenerator.stop();
  await mongoose.disconnect();
  
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
});

const startServer = async () => {
  try {
    await mongoose.connect(config.mongoUri);
    logger.info(`Connected to MongoDB at ${config.mongoUri}`);
    
    // Initialize services
    await proofGenerator.initialize();
    await relayerService.initialize();
    
    // Start the HTTP server with socket.io
    server.listen(config.port, () => {
      logger.info(`Server running on port ${config.port} in ${config.environment} mode`);
    });
    
    // Start all services
    await proofGenerator.start();  // SP1-Helios operator
    await relayerService.start();  // Monitoring and transaction tracking
    
    // Start the ETH to Citrea relayer (handles actual bridging)
    //startEthToCitreaRelayer().catch(console.error);
    //startDemoEthToCitreaRelayer().catch(console.error);
    startDemoRealRelayer().catch(console.error);
    
    // Start the notification worker for email notifications
    startNotificationWorker().catch(console.error);
    
    logger.info('All services started successfully');
    logger.info('SP1-Helios operator running for state root updates');
    logger.info('ETH->Citrea relayer handling bridge transactions and proofs');
    logger.info('Email notification worker started');
  } catch (error) {
    logger.error(`Server startup error: ${error}`);
    process.exit(1);
  }
};

startServer();