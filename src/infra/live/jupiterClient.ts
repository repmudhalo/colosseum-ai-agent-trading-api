import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

export interface JupiterQuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: number;
  slippageBps?: number;
  platformFeeBps?: number;
}

export interface JupiterQuoteResponse {
  inAmount?: string;
  outAmount?: string;
  routePlan?: unknown[];
  [key: string]: unknown;
}

export interface JupiterSwapResult {
  txSignature?: string;
  quote: JupiterQuoteResponse;
  simulated: boolean;
}

export class JupiterClient {
  private readonly connection?: Connection;
  private readonly signer?: Keypair;

  constructor(
    private readonly quoteUrl: string,
    private readonly swapUrl: string,
    rpcUrl?: string,
    privateKeyB58?: string,
    private readonly broadcastEnabled = false,
  ) {
    if (rpcUrl) {
      this.connection = new Connection(rpcUrl, 'confirmed');
    }

    if (privateKeyB58) {
      this.signer = Keypair.fromSecretKey(bs58.decode(privateKeyB58));
    }
  }

  isReadyForLive(): boolean {
    return Boolean(this.connection && this.signer);
  }

  publicKey(): string | undefined {
    return this.signer?.publicKey.toBase58();
  }

  async quote(params: JupiterQuoteRequest): Promise<JupiterQuoteResponse> {
    const query = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: String(params.amount),
      slippageBps: String(params.slippageBps ?? 50),
      platformFeeBps: String(params.platformFeeBps ?? 0),
    });

    const response = await fetch(`${this.quoteUrl}?${query.toString()}`);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jupiter quote failed: ${response.status} ${body}`);
    }

    return (await response.json()) as JupiterQuoteResponse;
  }

  async swapFromQuote(quote: JupiterQuoteResponse, feeAccount?: string): Promise<JupiterSwapResult> {
    if (!this.signer) {
      return { quote, simulated: true };
    }

    const payload = {
      quoteResponse: quote,
      userPublicKey: this.signer.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      feeAccount,
    };

    const response = await fetch(this.swapUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jupiter swap build failed: ${response.status} ${body}`);
    }

    const body = (await response.json()) as { swapTransaction?: string };
    if (!body.swapTransaction) {
      return { quote, simulated: true };
    }

    const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, 'base64'));
    tx.sign([this.signer]);

    if (!this.broadcastEnabled || !this.connection) {
      return { quote, simulated: true };
    }

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    });

    await this.connection.confirmTransaction(signature, 'confirmed');

    return {
      quote,
      txSignature: signature,
      simulated: false,
    };
  }
}
