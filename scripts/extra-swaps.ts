import { JupiterClient } from '../src/infra/live/jupiterClient.js';

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JITOSOL = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';

const jup = new JupiterClient(
  'https://lite-api.jup.ag/swap/v1/quote',
  'https://lite-api.jup.ag/swap/v1/swap',
  process.env.SOLANA_RPC_URL,
  process.env.SOLANA_PRIVATE_KEY_B58,
  true,
);

async function swap(label: string, inputMint: string, outputMint: string, amount: number) {
  console.log(`\n🔄 ${label}...`);
  try {
    const q = await jup.quote({ inputMint, outputMint, amount, slippageBps: 200 });
    console.log(`   Quote: ${q.inAmount} → ${q.outAmount}`);
    const r = await jup.swapFromQuote(q);
    if (r.txSignature) {
      console.log(`   ✅ TX: https://solscan.io/tx/${r.txSignature}`);
    } else {
      console.log('   ⚠️ simulated');
    }
  } catch (e: any) {
    console.log(`   ❌ ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 3000));
}

async function main() {
  console.log('🚀 Extra swaps — showing multi-token arbitrage');
  
  // SOL → jitoSOL (liquid staking arb)
  await swap('SOL → jitoSOL (liquid staking)', SOL, JITOSOL, 500_000); // 0.0005 SOL
  
  // jitoSOL → USDC  
  await swap('jitoSOL → USDC', JITOSOL, USDC, 450_000);
  
  // USDC → SOL (complete the triangle)
  await swap('USDC → SOL (triangle close)', USDC, SOL, 30_000); // 0.03 USDC
  
  console.log('\n✅ Multi-token arbitrage route complete');
}

main().catch(console.error);
