/**
 * Agent Identity & Credentials Service — Decentralized Identity for Agents
 *
 * Provides a W3C-inspired decentralized identity layer for AI trading agents:
 * - DID (Decentralized Identifier) generation for agents
 * - Verifiable credential issuance (trade history, reputation, compliance status)
 * - Credential verification (verify another agent's credentials)
 * - Identity attestation (third-party attestations about an agent)
 * - Credential revocation
 * - Identity registry (lookup agents by DID)
 */

import crypto from 'node:crypto';
import { isoNow } from '../utils/time.js';
import { sha256Hex } from '../utils/hash.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type CredentialType = 'trade-history' | 'reputation' | 'compliance' | 'skill-certification' | 'performance';

export interface AgentDID {
  did: string;                  // e.g. "did:solana-agent:abc123..."
  agentId: string;
  publicKey: string;            // hex-encoded ed25519-like public key
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface VerifiableCredential {
  id: string;                   // unique credential ID
  type: CredentialType;
  issuerDid: string;            // DID of the issuer
  subjectDid: string;           // DID of the subject
  claims: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string | null;
  signature: string;            // hex-encoded HMAC signature
  revoked: boolean;
  revokedAt: string | null;
}

export interface IdentityAttestation {
  id: string;
  attesterDid: string;          // DID of the attester
  subjectDid: string;           // DID of the subject being attested
  attestationType: string;      // e.g. "kyc-verified", "trusted-counterparty", "audited"
  claim: string;                // human-readable attestation statement
  evidence: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string | null;
  signature: string;
}

export interface AgentIdentity {
  did: AgentDID;
  credentials: VerifiableCredential[];
  attestations: IdentityAttestation[];
}

export interface RegistryEntry {
  did: string;
  agentId: string;
  publicKey: string;
  credentialCount: number;
  attestationCount: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface CredentialVerificationResult {
  valid: boolean;
  credentialId: string;
  issuerDid: string;
  subjectDid: string;
  type: CredentialType;
  expired: boolean;
  revoked: boolean;
  signatureValid: boolean;
  verifiedAt: string;
}

export interface CreateIdentityInput {
  agentId: string;
  metadata?: Record<string, unknown>;
}

export interface IssueCredentialInput {
  issuerDid: string;
  subjectDid: string;
  type: CredentialType;
  claims: Record<string, unknown>;
  expiresInMs?: number;
}

export interface AttestInput {
  attesterDid: string;
  subjectDid: string;
  attestationType: string;
  claim: string;
  evidence?: Record<string, unknown>;
  expiresInMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

const DID_METHOD = 'did:solana-agent';
const SIGNING_SECRET = 'agent-identity-hmac-secret-v1';

// ─── Service ────────────────────────────────────────────────────────────

export class AgentIdentityService {
  /** DID → AgentIdentity */
  private identities: Map<string, AgentIdentity> = new Map();
  /** agentId → DID (reverse lookup) */
  private agentIdToDid: Map<string, string> = new Map();
  /** credentialId → VerifiableCredential (for quick verification) */
  private credentialIndex: Map<string, VerifiableCredential> = new Map();

  /**
   * Create a new decentralized identity for an agent.
   * Generates a DID, a key pair simulation, and stores the identity.
   */
  createIdentity(input: CreateIdentityInput): AgentIdentity {
    const { agentId, metadata = {} } = input;

    // Check if agent already has an identity
    if (this.agentIdToDid.has(agentId)) {
      throw new Error(`Agent '${agentId}' already has an identity`);
    }

    // Generate a deterministic-ish but unique DID
    const nonce = crypto.randomBytes(16).toString('hex');
    const didSuffix = sha256Hex(`${agentId}:${nonce}`).slice(0, 32);
    const did = `${DID_METHOD}:${didSuffix}`;

    // Simulate key pair generation (public key is a hash-derived hex string)
    const publicKey = sha256Hex(`${did}:pubkey:${nonce}`);

    const now = isoNow();

    const agentDid: AgentDID = {
      did,
      agentId,
      publicKey,
      createdAt: now,
      updatedAt: now,
      metadata,
    };

    const identity: AgentIdentity = {
      did: agentDid,
      credentials: [],
      attestations: [],
    };

    this.identities.set(did, identity);
    this.agentIdToDid.set(agentId, did);

    return { ...identity };
  }

  /**
   * Get an agent's full identity including credentials and attestations.
   */
  getIdentity(agentId: string): AgentIdentity | null {
    const did = this.agentIdToDid.get(agentId);
    if (!did) return null;

    const identity = this.identities.get(did);
    if (!identity) return null;

    return {
      did: { ...identity.did },
      credentials: identity.credentials.map((c) => ({ ...c })),
      attestations: identity.attestations.map((a) => ({ ...a })),
    };
  }

  /**
   * Get identity by DID directly.
   */
  getIdentityByDid(did: string): AgentIdentity | null {
    const identity = this.identities.get(did);
    if (!identity) return null;

    return {
      did: { ...identity.did },
      credentials: identity.credentials.map((c) => ({ ...c })),
      attestations: identity.attestations.map((a) => ({ ...a })),
    };
  }

  /**
   * Issue a verifiable credential to an agent.
   * The issuer must also have a DID in the system.
   */
  issueCredential(input: IssueCredentialInput): VerifiableCredential {
    const { issuerDid, subjectDid, type, claims, expiresInMs } = input;

    // Validate issuer exists
    if (!this.identities.has(issuerDid)) {
      throw new Error(`Issuer DID '${issuerDid}' not found`);
    }

    // Validate subject exists
    const subjectIdentity = this.identities.get(subjectDid);
    if (!subjectIdentity) {
      throw new Error(`Subject DID '${subjectDid}' not found`);
    }

    const now = isoNow();
    const credentialId = `vc-${crypto.randomBytes(12).toString('hex')}`;

    const expiresAt = expiresInMs
      ? new Date(Date.now() + expiresInMs).toISOString()
      : null;

    // Create signature over the credential content
    const signaturePayload = JSON.stringify({
      id: credentialId,
      type,
      issuerDid,
      subjectDid,
      claims,
      issuedAt: now,
      expiresAt,
    });
    const signature = this.sign(signaturePayload);

    const credential: VerifiableCredential = {
      id: credentialId,
      type,
      issuerDid,
      subjectDid,
      claims,
      issuedAt: now,
      expiresAt,
      signature,
      revoked: false,
      revokedAt: null,
    };

    // Store on the subject's identity
    subjectIdentity.credentials.push(credential);
    subjectIdentity.did.updatedAt = now;

    // Index for quick lookup
    this.credentialIndex.set(credentialId, credential);

    return { ...credential };
  }

  /**
   * Verify a credential by its ID.
   * Checks signature validity, expiration, and revocation status.
   */
  verifyCredential(credentialId: string): CredentialVerificationResult {
    const credential = this.credentialIndex.get(credentialId);
    if (!credential) {
      throw new Error(`Credential '${credentialId}' not found`);
    }

    const now = new Date();

    // Check expiration
    const expired = credential.expiresAt !== null
      ? new Date(credential.expiresAt) < now
      : false;

    // Verify signature
    const signaturePayload = JSON.stringify({
      id: credential.id,
      type: credential.type,
      issuerDid: credential.issuerDid,
      subjectDid: credential.subjectDid,
      claims: credential.claims,
      issuedAt: credential.issuedAt,
      expiresAt: credential.expiresAt,
    });
    const expectedSignature = this.sign(signaturePayload);
    const signatureValid = credential.signature === expectedSignature;

    // Overall validity
    const valid = signatureValid && !expired && !credential.revoked;

    return {
      valid,
      credentialId: credential.id,
      issuerDid: credential.issuerDid,
      subjectDid: credential.subjectDid,
      type: credential.type,
      expired,
      revoked: credential.revoked,
      signatureValid,
      verifiedAt: isoNow(),
    };
  }

  /**
   * Revoke a credential. Only the issuer can revoke.
   */
  revokeCredential(credentialId: string, revokerDid: string): VerifiableCredential {
    const credential = this.credentialIndex.get(credentialId);
    if (!credential) {
      throw new Error(`Credential '${credentialId}' not found`);
    }

    if (credential.issuerDid !== revokerDid) {
      throw new Error('Only the issuer can revoke a credential');
    }

    if (credential.revoked) {
      throw new Error('Credential is already revoked');
    }

    const now = isoNow();
    credential.revoked = true;
    credential.revokedAt = now;

    // Update subject identity timestamp
    const subjectIdentity = this.identities.get(credential.subjectDid);
    if (subjectIdentity) {
      subjectIdentity.did.updatedAt = now;
    }

    return { ...credential };
  }

  /**
   * Add a third-party attestation about an agent.
   */
  addAttestation(input: AttestInput): IdentityAttestation {
    const { attesterDid, subjectDid, attestationType, claim, evidence = {}, expiresInMs } = input;

    // Validate attester exists
    if (!this.identities.has(attesterDid)) {
      throw new Error(`Attester DID '${attesterDid}' not found`);
    }

    // Validate subject exists
    const subjectIdentity = this.identities.get(subjectDid);
    if (!subjectIdentity) {
      throw new Error(`Subject DID '${subjectDid}' not found`);
    }

    // Cannot self-attest
    if (attesterDid === subjectDid) {
      throw new Error('Cannot self-attest');
    }

    const now = isoNow();
    const attestationId = `att-${crypto.randomBytes(12).toString('hex')}`;

    const expiresAt = expiresInMs
      ? new Date(Date.now() + expiresInMs).toISOString()
      : null;

    // Create signature
    const signaturePayload = JSON.stringify({
      id: attestationId,
      attesterDid,
      subjectDid,
      attestationType,
      claim,
      evidence,
      issuedAt: now,
      expiresAt,
    });
    const signature = this.sign(signaturePayload);

    const attestation: IdentityAttestation = {
      id: attestationId,
      attesterDid,
      subjectDid,
      attestationType,
      claim,
      evidence,
      issuedAt: now,
      expiresAt,
      signature,
    };

    subjectIdentity.attestations.push(attestation);
    subjectIdentity.did.updatedAt = now;

    return { ...attestation };
  }

  /**
   * Search the identity registry.
   * Supports filtering by agentId prefix, DID prefix, and metadata.
   */
  searchRegistry(query?: {
    agentIdPrefix?: string;
    didPrefix?: string;
    hasCredentialType?: CredentialType;
    limit?: number;
  }): RegistryEntry[] {
    const limit = query?.limit ?? 50;
    const results: RegistryEntry[] = [];

    for (const [, identity] of this.identities) {
      // Filter by agentId prefix
      if (query?.agentIdPrefix && !identity.did.agentId.startsWith(query.agentIdPrefix)) {
        continue;
      }

      // Filter by DID prefix
      if (query?.didPrefix && !identity.did.did.startsWith(query.didPrefix)) {
        continue;
      }

      // Filter by credential type
      if (query?.hasCredentialType) {
        const hasType = identity.credentials.some(
          (c) => c.type === query.hasCredentialType && !c.revoked,
        );
        if (!hasType) continue;
      }

      results.push({
        did: identity.did.did,
        agentId: identity.did.agentId,
        publicKey: identity.did.publicKey,
        credentialCount: identity.credentials.filter((c) => !c.revoked).length,
        attestationCount: identity.attestations.length,
        createdAt: identity.did.createdAt,
        metadata: identity.did.metadata,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * Get count of all identities in the registry.
   */
  getRegistrySize(): number {
    return this.identities.size;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────

  /**
   * HMAC-based signature simulation.
   * In production, this would use the agent's private key.
   */
  private sign(payload: string): string {
    return crypto
      .createHmac('sha256', SIGNING_SECRET)
      .update(payload)
      .digest('hex');
  }
}
