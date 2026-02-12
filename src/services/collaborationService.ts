/**
 * Agent Collaboration Protocol Service.
 *
 * Enables agents to form collaborations for signal sharing, co-trading,
 * and strategy exchange. Includes signal broadcasting within active
 * collaborations and lifecycle management (propose → accept/reject → terminate).
 */

import { v4 as uuid } from 'uuid';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

// ─── Types ──────────────────────────────────────────────────────────────

export type CollaborationType = 'signal-sharing' | 'co-trading' | 'strategy-exchange';
export type CollaborationStatus = 'proposed' | 'active' | 'rejected' | 'terminated';

export interface CollaborationTerms {
  type: CollaborationType;
  durationMs: number;
  profitSplitPct: number;
}

export interface Collaboration {
  id: string;
  initiatorId: string;
  targetId: string;
  terms: CollaborationTerms;
  status: CollaborationStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  terminatedBy?: string;
}

export interface CollaborationSignal {
  id: string;
  collaborationId: string;
  senderId: string;
  signal: {
    symbol: string;
    side: 'buy' | 'sell';
    confidence: number;
    priceTarget?: number;
    notes?: string;
    [key: string]: unknown;
  };
  createdAt: string;
}

// ─── Service ────────────────────────────────────────────────────────────

export class CollaborationService {
  private collaborations: Map<string, Collaboration> = new Map();
  private signals: Map<string, CollaborationSignal[]> = new Map();

  constructor(private readonly store: StateStore) {}

  proposeCollaboration(
    initiatorId: string,
    targetId: string,
    terms: CollaborationTerms,
  ): Collaboration {
    const state = this.store.snapshot();

    if (!state.agents[initiatorId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Initiator agent '${initiatorId}' not found.`);
    }
    if (!state.agents[targetId]) {
      throw new DomainError(ErrorCode.AgentNotFound, 404, `Target agent '${targetId}' not found.`);
    }
    if (initiatorId === targetId) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'An agent cannot collaborate with itself.');
    }
    if (terms.profitSplitPct < 0 || terms.profitSplitPct > 100) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'profitSplitPct must be between 0 and 100.');
    }
    if (terms.durationMs <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'durationMs must be positive.');
    }

    const now = isoNow();
    const collab: Collaboration = {
      id: uuid(),
      initiatorId,
      targetId,
      terms,
      status: 'proposed',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + terms.durationMs).toISOString(),
    };

    this.collaborations.set(collab.id, collab);
    this.signals.set(collab.id, []);

    eventBus.emit('collaboration.proposed', {
      collaborationId: collab.id,
      initiatorId,
      targetId,
      type: terms.type,
    });

    return structuredClone(collab);
  }

  acceptCollaboration(collabId: string, agentId: string): Collaboration {
    const collab = this.collaborations.get(collabId);
    if (!collab) {
      throw new DomainError(ErrorCode.CollaborationNotFound, 404, `Collaboration '${collabId}' not found.`);
    }
    if (collab.status !== 'proposed') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Collaboration is '${collab.status}', not 'proposed'.`);
    }
    if (collab.targetId !== agentId) {
      throw new DomainError(ErrorCode.InvalidPayload, 403, 'Only the target agent can accept a collaboration.');
    }

    collab.status = 'active';
    collab.updatedAt = isoNow();
    collab.expiresAt = new Date(Date.now() + collab.terms.durationMs).toISOString();

    eventBus.emit('collaboration.accepted', {
      collaborationId: collab.id,
      initiatorId: collab.initiatorId,
      targetId: collab.targetId,
    });

    return structuredClone(collab);
  }

  rejectCollaboration(collabId: string, agentId: string): Collaboration {
    const collab = this.collaborations.get(collabId);
    if (!collab) {
      throw new DomainError(ErrorCode.CollaborationNotFound, 404, `Collaboration '${collabId}' not found.`);
    }
    if (collab.status !== 'proposed') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Collaboration is '${collab.status}', not 'proposed'.`);
    }
    if (collab.targetId !== agentId) {
      throw new DomainError(ErrorCode.InvalidPayload, 403, 'Only the target agent can reject a collaboration.');
    }

    collab.status = 'rejected';
    collab.updatedAt = isoNow();

    eventBus.emit('collaboration.rejected', {
      collaborationId: collab.id,
      initiatorId: collab.initiatorId,
      targetId: collab.targetId,
    });

    return structuredClone(collab);
  }

  getActiveCollaborations(agentId: string): Collaboration[] {
    const results: Collaboration[] = [];
    for (const collab of this.collaborations.values()) {
      if (
        (collab.initiatorId === agentId || collab.targetId === agentId) &&
        (collab.status === 'active' || collab.status === 'proposed')
      ) {
        results.push(structuredClone(collab));
      }
    }
    return results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  shareSignal(
    collabId: string,
    signal: CollaborationSignal['signal'],
  ): CollaborationSignal {
    const collab = this.collaborations.get(collabId);
    if (!collab) {
      throw new DomainError(ErrorCode.CollaborationNotFound, 404, `Collaboration '${collabId}' not found.`);
    }
    if (collab.status !== 'active') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Signals can only be shared in active collaborations.');
    }

    if (new Date(collab.expiresAt).getTime() < Date.now()) {
      collab.status = 'terminated';
      collab.updatedAt = isoNow();
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Collaboration has expired.');
    }

    const entry: CollaborationSignal = {
      id: uuid(),
      collaborationId: collabId,
      senderId: signal.symbol,
      signal,
      createdAt: isoNow(),
    };

    const signals = this.signals.get(collabId) ?? [];
    signals.push(entry);
    this.signals.set(collabId, signals);

    eventBus.emit('collaboration.signal', {
      collaborationId: collabId,
      signalId: entry.id,
      symbol: signal.symbol,
      side: signal.side,
    });

    return structuredClone(entry);
  }

  getSharedSignals(collabId: string): CollaborationSignal[] {
    const collab = this.collaborations.get(collabId);
    if (!collab) {
      throw new DomainError(ErrorCode.CollaborationNotFound, 404, `Collaboration '${collabId}' not found.`);
    }

    const signals = this.signals.get(collabId) ?? [];
    return signals.map((s) => structuredClone(s));
  }

  terminateCollaboration(collabId: string, agentId: string): Collaboration {
    const collab = this.collaborations.get(collabId);
    if (!collab) {
      throw new DomainError(ErrorCode.CollaborationNotFound, 404, `Collaboration '${collabId}' not found.`);
    }
    if (collab.status !== 'active' && collab.status !== 'proposed') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, `Collaboration is already '${collab.status}'.`);
    }
    if (collab.initiatorId !== agentId && collab.targetId !== agentId) {
      throw new DomainError(ErrorCode.InvalidPayload, 403, 'Only a participant can terminate a collaboration.');
    }

    collab.status = 'terminated';
    collab.updatedAt = isoNow();
    collab.terminatedBy = agentId;

    eventBus.emit('collaboration.terminated', {
      collaborationId: collab.id,
      terminatedBy: agentId,
    });

    return structuredClone(collab);
  }

  getById(collabId: string): Collaboration | null {
    return this.collaborations.get(collabId) ?? null;
  }
}
