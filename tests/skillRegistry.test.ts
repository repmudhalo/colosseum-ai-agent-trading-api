import { describe, it, expect, beforeEach } from 'vitest';
import { SkillRegistry } from '../src/domain/skills/skillRegistry.js';

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it('lists all built-in skills', () => {
    const skills = registry.listAll();
    expect(skills.length).toBeGreaterThanOrEqual(4);

    const ids = skills.map((s) => s.id);
    expect(ids).toContain('trade');
    expect(ids).toContain('monitor');
    expect(ids).toContain('arbitrage');
    expect(ids).toContain('lending');
  });

  it('retrieves a skill by id', () => {
    const trade = registry.getById('trade');
    expect(trade).toBeDefined();
    expect(trade!.name).toBe('Trade Execution');
    expect(trade!.capabilities.length).toBeGreaterThan(0);
  });

  it('returns undefined for unknown skill', () => {
    expect(registry.getById('nonexistent')).toBeUndefined();
  });

  it('registers a custom skill', () => {
    const custom = {
      id: 'my-custom-skill',
      name: 'Custom Skill',
      description: 'Does custom things.',
      version: '0.1.0',
      capabilities: ['custom-cap'],
    };

    registry.register(custom);
    expect(registry.getById('my-custom-skill')).toEqual(custom);
    expect(registry.listAll().map((s) => s.id)).toContain('my-custom-skill');
  });

  it('assigns default skills to an agent', () => {
    registry.assignDefaults('agent-1');
    const skills = registry.getAgentSkills('agent-1');
    expect(skills.length).toBe(4);
    expect(skills.map((s) => s.id).sort()).toEqual(['arbitrage', 'lending', 'monitor', 'trade']);
  });

  it('announces specific skills for an agent', () => {
    registry.announceAgentSkills('agent-2', ['trade', 'lending']);
    const skills = registry.getAgentSkills('agent-2');
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.id).sort()).toEqual(['lending', 'trade']);
  });

  it('ignores unknown skill ids when announcing', () => {
    registry.announceAgentSkills('agent-3', ['trade', 'nonexistent']);
    const skills = registry.getAgentSkills('agent-3');
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('trade');
  });

  it('returns empty array for agent with no skills', () => {
    expect(registry.getAgentSkills('unknown-agent')).toEqual([]);
  });

  it('accumulates skills across multiple announce calls', () => {
    registry.announceAgentSkills('agent-4', ['trade']);
    registry.announceAgentSkills('agent-4', ['lending', 'monitor']);
    const skills = registry.getAgentSkills('agent-4');
    expect(skills).toHaveLength(3);
  });
});
