import { describe, expect, it, beforeEach } from 'vitest';
import { AgentIdentityService, CredentialType } from '../src/services/agentIdentityService.js';

describe('AgentIdentityService', () => {
  let service: AgentIdentityService;

  beforeEach(() => {
    service = new AgentIdentityService();
  });

  // ─── DID Creation ─────────────────────────────────────────────────

  describe('createIdentity()', () => {
    it('should generate a DID for a new agent', () => {
      const identity = service.createIdentity({ agentId: 'agent-001' });

      expect(identity.did.did).toMatch(/^did:solana-agent:[a-f0-9]{32}$/);
      expect(identity.did.agentId).toBe('agent-001');
      expect(identity.did.publicKey).toBeTruthy();
      expect(identity.did.publicKey).toHaveLength(64); // sha256 hex
      expect(identity.did.createdAt).toBeTruthy();
      expect(identity.credentials).toEqual([]);
      expect(identity.attestations).toEqual([]);
    });

    it('should store metadata in the DID document', () => {
      const identity = service.createIdentity({
        agentId: 'agent-002',
        metadata: { strategy: 'momentum-v1', tier: 'premium' },
      });

      expect(identity.did.metadata).toEqual({ strategy: 'momentum-v1', tier: 'premium' });
    });

    it('should reject duplicate identity for the same agent', () => {
      service.createIdentity({ agentId: 'agent-dup' });

      expect(() => service.createIdentity({ agentId: 'agent-dup' }))
        .toThrow("Agent 'agent-dup' already has an identity");
    });

    it('should generate unique DIDs for different agents', () => {
      const id1 = service.createIdentity({ agentId: 'agent-a' });
      const id2 = service.createIdentity({ agentId: 'agent-b' });

      expect(id1.did.did).not.toBe(id2.did.did);
      expect(id1.did.publicKey).not.toBe(id2.did.publicKey);
    });
  });

  // ─── Get Identity ─────────────────────────────────────────────────

  describe('getIdentity()', () => {
    it('should retrieve identity by agentId', () => {
      const created = service.createIdentity({ agentId: 'agent-get' });
      const fetched = service.getIdentity('agent-get');

      expect(fetched).not.toBeNull();
      expect(fetched!.did.did).toBe(created.did.did);
      expect(fetched!.did.agentId).toBe('agent-get');
    });

    it('should return null for unknown agentId', () => {
      const result = service.getIdentity('nonexistent');
      expect(result).toBeNull();
    });
  });

  // ─── Credential Issuance ──────────────────────────────────────────

  describe('issueCredential()', () => {
    it('should issue a verifiable credential', () => {
      const issuer = service.createIdentity({ agentId: 'issuer-001' });
      const subject = service.createIdentity({ agentId: 'subject-001' });

      const credential = service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: subject.did.did,
        type: 'trade-history',
        claims: { totalTrades: 150, winRate: 0.72, avgPnl: 250.5 },
      });

      expect(credential.id).toMatch(/^vc-[a-f0-9]{24}$/);
      expect(credential.type).toBe('trade-history');
      expect(credential.issuerDid).toBe(issuer.did.did);
      expect(credential.subjectDid).toBe(subject.did.did);
      expect(credential.claims).toEqual({ totalTrades: 150, winRate: 0.72, avgPnl: 250.5 });
      expect(credential.signature).toBeTruthy();
      expect(credential.revoked).toBe(false);
      expect(credential.revokedAt).toBeNull();
    });

    it('should attach credential to subject identity', () => {
      const issuer = service.createIdentity({ agentId: 'issuer-att' });
      const subject = service.createIdentity({ agentId: 'subject-att' });

      service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: subject.did.did,
        type: 'reputation',
        claims: { score: 850 },
      });

      const identity = service.getIdentity('subject-att');
      expect(identity!.credentials).toHaveLength(1);
      expect(identity!.credentials[0].type).toBe('reputation');
    });

    it('should support credential expiration', () => {
      const issuer = service.createIdentity({ agentId: 'issuer-exp' });
      const subject = service.createIdentity({ agentId: 'subject-exp' });

      const credential = service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: subject.did.did,
        type: 'compliance',
        claims: { amlStatus: 'cleared' },
        expiresInMs: 3600_000, // 1 hour
      });

      expect(credential.expiresAt).not.toBeNull();
      const expiresDate = new Date(credential.expiresAt!);
      const now = new Date();
      // Should expire roughly 1 hour from now
      expect(expiresDate.getTime() - now.getTime()).toBeGreaterThan(3500_000);
      expect(expiresDate.getTime() - now.getTime()).toBeLessThan(3700_000);
    });

    it('should reject issuance from unknown issuer DID', () => {
      const subject = service.createIdentity({ agentId: 'subject-bad' });

      expect(() => service.issueCredential({
        issuerDid: 'did:solana-agent:unknown',
        subjectDid: subject.did.did,
        type: 'reputation',
        claims: {},
      })).toThrow("Issuer DID 'did:solana-agent:unknown' not found");
    });

    it('should reject issuance to unknown subject DID', () => {
      const issuer = service.createIdentity({ agentId: 'issuer-bad' });

      expect(() => service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: 'did:solana-agent:unknown',
        type: 'reputation',
        claims: {},
      })).toThrow("Subject DID 'did:solana-agent:unknown' not found");
    });
  });

  // ─── Credential Verification ──────────────────────────────────────

  describe('verifyCredential()', () => {
    it('should verify a valid credential', () => {
      const issuer = service.createIdentity({ agentId: 'v-issuer' });
      const subject = service.createIdentity({ agentId: 'v-subject' });

      const credential = service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: subject.did.did,
        type: 'trade-history',
        claims: { totalTrades: 50 },
      });

      const result = service.verifyCredential(credential.id);

      expect(result.valid).toBe(true);
      expect(result.signatureValid).toBe(true);
      expect(result.expired).toBe(false);
      expect(result.revoked).toBe(false);
      expect(result.credentialId).toBe(credential.id);
      expect(result.verifiedAt).toBeTruthy();
    });

    it('should detect revoked credentials as invalid', () => {
      const issuer = service.createIdentity({ agentId: 'rv-issuer' });
      const subject = service.createIdentity({ agentId: 'rv-subject' });

      const credential = service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: subject.did.did,
        type: 'compliance',
        claims: { status: 'cleared' },
      });

      service.revokeCredential(credential.id, issuer.did.did);

      const result = service.verifyCredential(credential.id);

      expect(result.valid).toBe(false);
      expect(result.revoked).toBe(true);
      expect(result.signatureValid).toBe(true); // signature is still correct
    });

    it('should throw for unknown credential ID', () => {
      expect(() => service.verifyCredential('vc-nonexistent'))
        .toThrow("Credential 'vc-nonexistent' not found");
    });
  });

  // ─── Credential Revocation ────────────────────────────────────────

  describe('revokeCredential()', () => {
    it('should revoke a credential by the issuer', () => {
      const issuer = service.createIdentity({ agentId: 'rk-issuer' });
      const subject = service.createIdentity({ agentId: 'rk-subject' });

      const credential = service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: subject.did.did,
        type: 'reputation',
        claims: { score: 900 },
      });

      const revoked = service.revokeCredential(credential.id, issuer.did.did);

      expect(revoked.revoked).toBe(true);
      expect(revoked.revokedAt).toBeTruthy();
    });

    it('should reject revocation by non-issuer', () => {
      const issuer = service.createIdentity({ agentId: 'rk2-issuer' });
      const subject = service.createIdentity({ agentId: 'rk2-subject' });
      const stranger = service.createIdentity({ agentId: 'rk2-stranger' });

      const credential = service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: subject.did.did,
        type: 'reputation',
        claims: { score: 500 },
      });

      expect(() => service.revokeCredential(credential.id, stranger.did.did))
        .toThrow('Only the issuer can revoke a credential');
    });

    it('should reject double revocation', () => {
      const issuer = service.createIdentity({ agentId: 'rk3-issuer' });
      const subject = service.createIdentity({ agentId: 'rk3-subject' });

      const credential = service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: subject.did.did,
        type: 'compliance',
        claims: {},
      });

      service.revokeCredential(credential.id, issuer.did.did);

      expect(() => service.revokeCredential(credential.id, issuer.did.did))
        .toThrow('Credential is already revoked');
    });
  });

  // ─── Attestations ─────────────────────────────────────────────────

  describe('addAttestation()', () => {
    it('should add a third-party attestation', () => {
      const attester = service.createIdentity({ agentId: 'att-attester' });
      const subject = service.createIdentity({ agentId: 'att-subject' });

      const attestation = service.addAttestation({
        attesterDid: attester.did.did,
        subjectDid: subject.did.did,
        attestationType: 'trusted-counterparty',
        claim: 'This agent has been verified as a reliable trading partner',
        evidence: { verificationDate: '2025-01-15', method: 'manual-review' },
      });

      expect(attestation.id).toMatch(/^att-[a-f0-9]{24}$/);
      expect(attestation.attesterDid).toBe(attester.did.did);
      expect(attestation.subjectDid).toBe(subject.did.did);
      expect(attestation.attestationType).toBe('trusted-counterparty');
      expect(attestation.claim).toBe('This agent has been verified as a reliable trading partner');
      expect(attestation.signature).toBeTruthy();

      // Verify it's stored on the subject
      const identity = service.getIdentity('att-subject');
      expect(identity!.attestations).toHaveLength(1);
    });

    it('should reject self-attestation', () => {
      const agent = service.createIdentity({ agentId: 'self-att' });

      expect(() => service.addAttestation({
        attesterDid: agent.did.did,
        subjectDid: agent.did.did,
        attestationType: 'kyc-verified',
        claim: 'I verified myself',
      })).toThrow('Cannot self-attest');
    });

    it('should reject attestation from unknown attester', () => {
      const subject = service.createIdentity({ agentId: 'att-sub2' });

      expect(() => service.addAttestation({
        attesterDid: 'did:solana-agent:fake',
        subjectDid: subject.did.did,
        attestationType: 'kyc',
        claim: 'test',
      })).toThrow("Attester DID 'did:solana-agent:fake' not found");
    });
  });

  // ─── Registry Search ──────────────────────────────────────────────

  describe('searchRegistry()', () => {
    it('should list all identities when no filter is applied', () => {
      service.createIdentity({ agentId: 'reg-a' });
      service.createIdentity({ agentId: 'reg-b' });
      service.createIdentity({ agentId: 'reg-c' });

      const results = service.searchRegistry();
      expect(results).toHaveLength(3);
      expect(results[0].agentId).toBeTruthy();
      expect(results[0].did).toMatch(/^did:solana-agent:/);
    });

    it('should filter by agentId prefix', () => {
      service.createIdentity({ agentId: 'team-alpha-1' });
      service.createIdentity({ agentId: 'team-alpha-2' });
      service.createIdentity({ agentId: 'team-beta-1' });

      const results = service.searchRegistry({ agentIdPrefix: 'team-alpha' });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.agentId.startsWith('team-alpha'))).toBe(true);
    });

    it('should filter by credential type', () => {
      const issuer = service.createIdentity({ agentId: 'reg-issuer' });
      const withCred = service.createIdentity({ agentId: 'reg-with-cred' });
      service.createIdentity({ agentId: 'reg-without-cred' });

      service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: withCred.did.did,
        type: 'compliance',
        claims: { status: 'approved' },
      });

      const results = service.searchRegistry({ hasCredentialType: 'compliance' });
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('reg-with-cred');
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        service.createIdentity({ agentId: `limit-agent-${i}` });
      }

      const results = service.searchRegistry({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('should include credential and attestation counts', () => {
      const issuer = service.createIdentity({ agentId: 'count-issuer' });
      const subject = service.createIdentity({ agentId: 'count-subject' });

      service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: subject.did.did,
        type: 'trade-history',
        claims: {},
      });
      service.issueCredential({
        issuerDid: issuer.did.did,
        subjectDid: subject.did.did,
        type: 'reputation',
        claims: {},
      });
      service.addAttestation({
        attesterDid: issuer.did.did,
        subjectDid: subject.did.did,
        attestationType: 'verified',
        claim: 'Verified agent',
      });

      const results = service.searchRegistry({ agentIdPrefix: 'count-subject' });
      expect(results).toHaveLength(1);
      expect(results[0].credentialCount).toBe(2);
      expect(results[0].attestationCount).toBe(1);
    });
  });

  // ─── End-to-end Flow ──────────────────────────────────────────────

  describe('end-to-end', () => {
    it('should support full identity lifecycle: create → issue → verify → attest → revoke → re-verify', () => {
      // 1. Create identities
      const authority = service.createIdentity({ agentId: 'authority', metadata: { role: 'compliance-officer' } });
      const trader = service.createIdentity({ agentId: 'trader-x', metadata: { strategy: 'arbitrage' } });

      // 2. Issue credential
      const cred = service.issueCredential({
        issuerDid: authority.did.did,
        subjectDid: trader.did.did,
        type: 'compliance',
        claims: { amlCleared: true, kycLevel: 3, jurisdiction: 'US' },
      });

      // 3. Verify — should be valid
      const v1 = service.verifyCredential(cred.id);
      expect(v1.valid).toBe(true);

      // 4. Add attestation
      service.addAttestation({
        attesterDid: authority.did.did,
        subjectDid: trader.did.did,
        attestationType: 'audit-passed',
        claim: 'Annual compliance audit passed with flying colors',
      });

      // 5. Check full identity
      const fullIdentity = service.getIdentity('trader-x');
      expect(fullIdentity!.credentials).toHaveLength(1);
      expect(fullIdentity!.attestations).toHaveLength(1);

      // 6. Revoke
      service.revokeCredential(cred.id, authority.did.did);

      // 7. Re-verify — should be invalid
      const v2 = service.verifyCredential(cred.id);
      expect(v2.valid).toBe(false);
      expect(v2.revoked).toBe(true);

      // 8. Registry lookup
      const registry = service.searchRegistry();
      expect(registry).toHaveLength(2);

      expect(service.getRegistrySize()).toBe(2);
    });
  });
});
