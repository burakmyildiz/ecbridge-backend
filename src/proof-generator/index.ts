// ECBridge/backend/src/proof-generator/index.ts
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import config from '../config';
import logger from '../utils/logger';

export class ProofGenerator {
  private sp1HeliosPath: string;
  private sp1HeliosOperatorProcess: ChildProcess | null = null;
  private isRunning: boolean = false;
  
  constructor() {
    this.sp1HeliosPath = path.resolve(config.sp1HeliosPath);
  }
  
  public async initialize(): Promise<void> {
    try {
      logger.info('Proof Generator service initialized (SP1-Helios operator only)');
    } catch (error) {
      logger.error(`Error initializing Proof Generator service: ${error}`);
      throw error;
    }
  }
  
  public async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Proof Generator service is already running');
      return;
    }
    
    this.isRunning = true;
    logger.info('Starting SP1-Helios operator service');
    
    this.startSP1HeliosOperator();
  }
  
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.warn('Proof Generator service is not running');
      return;
    }
    
    this.isRunning = false;
    logger.info('Stopping Proof Generator service');
    
    if (this.sp1HeliosOperatorProcess) {
      this.sp1HeliosOperatorProcess.kill();
      this.sp1HeliosOperatorProcess = null;
    }
  }
  
  private startSP1HeliosOperator(): void {
    if (this.sp1HeliosOperatorProcess) {
      this.sp1HeliosOperatorProcess.kill();
      this.sp1HeliosOperatorProcess = null;
    }
    
    logger.info('Starting SP1-Helios operator...');
    const heliosEnv = require('dotenv').config({ path: `${this.sp1HeliosPath}/.env` }).parsed ?? {};

    this.sp1HeliosOperatorProcess = spawn(
      'cargo', 
      ['run', '--release', '--bin', 'operator'],
      { 
        cwd: this.sp1HeliosPath,
        env: { ...process.env, ...heliosEnv, RUST_LOG: process.env.RUST_LOG ?? 'info' },
      }
    );
    
    this.sp1HeliosOperatorProcess.stdout?.on('data', (data) => {
      const output = data.toString();
      logger.info(`SP1-Helios operator: ${output}`);
      
      if (output.includes('Successfully updated to new head block')) {
        const txHashMatch = output.match(/Tx hash: (0x[a-fA-F0-9]+)/);
        if (txHashMatch && txHashMatch[1]) {
          logger.info(`SP1-Helios head updated, tx: ${txHashMatch[1]}`);
        }
      }
    });
    
    this.sp1HeliosOperatorProcess.stderr?.on('data', (data) => {
      logger.info(`SP1-Helios operator: ${data.toString().trim()}`);
    });
    
    this.sp1HeliosOperatorProcess.on('close', (code) => {
      if (this.isRunning) {
        logger.warn(`SP1-Helios operator exited with code ${code}, restarting...`);
        setTimeout(() => this.startSP1HeliosOperator(), 5000);
      } else {
        logger.info(`SP1-Helios operator exited with code ${code}`);
      }
    });
  }
  
  // Deprecated methods - kept for backward compatibility but do nothing
  public async queueProofTask(txHash: string, blockNumber: number): Promise<boolean> {
    logger.warn(`queueProofTask called but is deprecated - proof generation happens in ethToCitrea relayer`);
    return false;
  }
  
  public async getProofTaskStatus(txHash: string): Promise<{ status: string, proofData?: string, error?: string } | null> {
    return null;
  }
  
  public async hasProof(txHash: string): Promise<boolean> {
    return false;
  }
  
  public async getProofData(txHash: string): Promise<string | null> {
    return null;
  }
}

export const proofGenerator = new ProofGenerator();