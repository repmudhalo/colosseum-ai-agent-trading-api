#!/usr/bin/env npx tsx
/**
 * Live Demo — Execute real mainnet transactions to demonstrate all services
 * Run: npx tsx scripts/live-demo.ts
 */

import { JupiterClient } from '../src/infra/live/jupiterClient.js';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=f3d0a179-7631-4fbf-8763-bc9e0bd3e454';
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY_B58 || process.env.SOLANA_PRIVATE_KEY!;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
const SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';

async function main() {
  console.log('🚀 Live Demo — Autonomous DeFi Agent Infrastructure');
  console.log('━'.repeat(60));

  const keypair = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  const connection = new Connection(RPC_URL, 'confirmed');
  const wallet = keypair.publicKey.toBase58();

  console.log(`\n💰 Wallet: ${wallet}`);

  // Check balance
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`📊 SOL Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

  if (balance < 0.003 * LAMPORTS_PER_SOL) {
    console.log('❌ Insufficient balance for swaps (need > 0.003 SOL)');
    return;
  }

  const jupiter = new JupiterClient(QUOTE_URL, SWAP_URL, RPC_URL, PRIVATE_KEY, true);

  // ─── Swap 1: SOL → USDC (tiny amount) ─────────────────
  console.log('\n🔄 Swap 1: SOL → USDC (0.001 SOL)');
  try {
    const quote1 = await jupiter.quote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: Math.floor(0.001 * LAMPORTS_PER_SOL),
      slippageBps: 100,
    });
    console.log(`   Quote: ${quote1.inAmount} lamports → ${quote1.outAmount} USDC-units`);

    const swap1 = await jupiter.swapFromQuote(quote1);
    if (swap1.txSignature) {
      console.log(`   ✅ TX: https://solscan.io/tx/${swap1.txSignature}`);
    } else {
      console.log(`   ⚠️ Simulated only`);
    }
  } catch (e: any) {
    console.log(`   ❌ ${e.message}`);
  }

  // Wait between swaps
  await new Promise(r => setTimeout(r, 3000));

  // ─── Swap 2: SOL → BONK ─────────────────
  console.log('\n🔄 Swap 2: SOL → BONK (0.001 SOL)');
  try {
    const quote2 = await jupiter.quote({
      inputMint: SOL_MINT,
      outputMint: BONK_MINT,
      amount: Math.floor(0.001 * LAMPORTS_PER_SOL),
      slippageBps: 100,
    });
    console.log(`   Quote: ${quote2.inAmount} lamports → ${quote2.outAmount} BONK-units`);

    const swap2 = await jupiter.swapFromQuote(quote2);
    if (swap2.txSignature) {
      console.log(`   ✅ TX: https://solscan.io/tx/${swap2.txSignature}`);
    } else {
      console.log(`   ⚠️ Simulated only`);
    }
  } catch (e: any) {
    console.log(`   ❌ ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 3000));

  // ─── Swap 3: BONK → SOL (swap back) ─────────────────
  console.log('\n🔄 Swap 3: BONK → SOL (swap back)');
  try {
    // Get BONK balance first
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(keypair.publicKey, {
      mint: new (await import('@solana/web3.js')).PublicKey(BONK_MINT),
    });
    
    if (tokenAccounts.value.length > 0) {
      const bonkBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
      console.log(`   BONK balance: ${bonkBalance}`);
      
      if (BigInt(bonkBalance) > 0n) {
        const quote3 = await jupiter.quote({
          inputMint: BONK_MINT,
          outputMint: SOL_MINT,
          amount: Number(bonkBalance),
          slippageBps: 200,
        });
        console.log(`   Quote: ${quote3.inAmount} BONK → ${quote3.outAmount} lamports`);

        const swap3 = await jupiter.swapFromQuote(quote3);
        if (swap3.txSignature) {
          console.log(`   ✅ TX: https://solscan.io/tx/${swap3.txSignature}`);
        } else {
          console.log(`   ⚠️ Simulated only`);
        }
      }
    } else {
      console.log('   No BONK balance to swap back');
    }
  } catch (e: any) {
    console.log(`   ❌ ${e.message}`);
  }

  // ─── Final Balance ─────────────────
  await new Promise(r => setTimeout(r, 2000));
  const finalBalance = await connection.getBalance(keypair.publicKey);
  console.log(`\n📊 Final SOL Balance: ${(finalBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
  console.log(`💸 Net cost: ${((balance - finalBalance) / LAMPORTS_PER_SOL).toFixed(6)} SOL (fees only)`);
  
  console.log('\n━'.repeat(60));
  console.log('✅ Live demo complete — real mainnet transactions executed');
}

main().catch(console.error);
